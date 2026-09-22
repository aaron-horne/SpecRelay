import { Link, useParams } from "wouter"
import { 
  useGetApi, 
  useImportSpecification, 
  useListOperations,
  useListCredentials,
  saveCredential,
  useRevokeCredential,
  getGetApiQueryKey,
  getListOperationsQueryKey,
  getListCredentialsQueryKey,
  type ApiSecurityScheme,
  type CredentialMetadata
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useState } from "react"
import { 
  FileCode2, 
  Activity,
  Upload,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Key,
  ShieldCheck,
  Ban,
  RotateCcw
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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

const importSchema = z.object({
  document: z.string().min(2, "Document content is required").max(2097152),
  filename: z.string().optional()
})

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  POST: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PUT: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  PATCH: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  DELETE: "bg-red-500/10 text-red-700 dark:text-red-400",
}

const credentialSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(120),
  secret: z.string().min(1, "Secret is required").max(8192),
})

function isSupportedScheme(scheme: ApiSecurityScheme) {
  return (scheme.type === "apiKey" && (scheme.location === "header" || scheme.location === "query")) ||
    (scheme.type === "http" && scheme.bearer && scheme.location === "header")
}

function schemeLabel(scheme: ApiSecurityScheme) {
  return scheme.type === "http" ? "Bearer token" : `API key (${scheme.location})`
}

function credentialFor(scheme: ApiSecurityScheme | null, credentials: CredentialMetadata[] | undefined) {
  return scheme ? credentials?.find((credential) => credential.schemeName === scheme.name) : undefined
}

export default function ApiDetailPage() {
  const { workspaceId, apiId } = useParams()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [importOpen, setImportOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [credentialOpen, setCredentialOpen] = useState(false)
  const [credentialScheme, setCredentialScheme] = useState<ApiSecurityScheme | null>(null)
  const [credentialPending, setCredentialPending] = useState(false)

  const { data: detail, isLoading: apiLoading } = useGetApi(workspaceId || "", apiId || "")
  const { data: operations, isLoading: opsLoading } = useListOperations(workspaceId || "", apiId || "")
  const { data: credentials, isLoading: credentialsLoading } = useListCredentials(workspaceId || "", apiId || "")
  const importSpec = useImportSpecification()
  const revokeCredential = useRevokeCredential()

  const form = useForm<z.infer<typeof importSchema>>({
    resolver: zodResolver(importSchema),
    defaultValues: { document: "", filename: "" }
  })
  const credentialForm = useForm<z.infer<typeof credentialSchema>>({
    resolver: zodResolver(credentialSchema),
    defaultValues: { label: "", secret: "" },
  })

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      form.setValue("document", content)
      form.setValue("filename", file.name)
    }
    reader.readAsText(file)
  }

  function onImportSubmit(values: z.infer<typeof importSchema>) {
    if (!workspaceId || !apiId) return
    importSpec.mutate(
      { workspaceId, apiId, data: values },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getGetApiQueryKey(workspaceId, apiId) })
          queryClient.invalidateQueries({ queryKey: getListOperationsQueryKey(workspaceId, apiId) })
          toast({ 
            title: "Import Successful", 
            description: `Imported ${result.operations.length} operations. Valid: ${result.validation.valid ? "Yes" : "No"}` 
          })
          setImportOpen(false)
          form.reset()
        },
        onError: (err) => {
          toast({ title: "Import Failed", description: err.message || "Failed to parse/import spec", variant: "destructive" })
        }
      }
    )
  }

  function openCredentialDialog(scheme: ApiSecurityScheme) {
    setCredentialScheme(scheme)
    credentialForm.reset({ label: credentialFor(scheme, credentials)?.label || "", secret: "" })
    setCredentialOpen(true)
  }

  function closeCredentialDialog(open: boolean) {
    setCredentialOpen(open)
    if (!open) {
      credentialForm.reset({ label: "", secret: "" })
      setCredentialScheme(null)
    }
  }

  async function onCredentialSubmit(values: z.infer<typeof credentialSchema>) {
    if (!workspaceId || !apiId || !credentialScheme) return
    const schemeName = credentialScheme.name
    const label = values.label
    const secret = values.secret
    // Remove the write-only secret from form state before handing it to the request.
    credentialForm.reset({ label, secret: "" })
    setCredentialPending(true)
    try {
      await saveCredential(workspaceId, apiId, { schemeName, label, secret })
      queryClient.invalidateQueries({ queryKey: getListCredentialsQueryKey(workspaceId, apiId) })
      queryClient.invalidateQueries({ queryKey: getGetApiQueryKey(workspaceId, apiId) })
      queryClient.invalidateQueries({ queryKey: getListOperationsQueryKey(workspaceId, apiId) })
      toast({ title: "Credential configured", description: `${schemeLabel(credentialScheme)} is ready for approved GET operations.` })
      closeCredentialDialog(false)
    } catch {
      toast({ title: "Credential not saved", description: "Unable to save credential.", variant: "destructive" })
    } finally {
      credentialForm.reset({ label, secret: "" })
      setCredentialPending(false)
    }
  }

  function onCredentialRevoke(credential: CredentialMetadata) {
    if (!workspaceId || !apiId) return
    revokeCredential.mutate(
      { workspaceId, apiId, credentialId: credential.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCredentialsQueryKey(workspaceId, apiId) })
          queryClient.invalidateQueries({ queryKey: getListOperationsQueryKey(workspaceId, apiId) })
          toast({ title: "Credential revoked", description: `${credential.label} can no longer be used for execution.` })
        },
        onError: (err) => toast({ title: "Credential not revoked", description: err.message || "Unable to revoke credential", variant: "destructive" }),
      },
    )
  }

  if (!workspaceId || !apiId) return null

  if (apiLoading) {
    return <div className="space-y-6"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>
  }

  if (!detail) {
    return <div className="text-destructive">API not found.</div>
  }

  const { api } = detail
  const supportedSchemes = api.latestSpecification?.securitySchemes.filter(isSupportedScheme) || []
  const filteredOps = operations?.filter(o => 
    o.path.toLowerCase().includes(search.toLowerCase()) || 
    o.method.toLowerCase().includes(search.toLowerCase()) ||
    o.displayName.toLowerCase().includes(search.toLowerCase())
  ) || []

  const enabledCount = operations?.filter(o => o.enabled).length || 0
  const totalCount = operations?.length || 0

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
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
            <BreadcrumbPage>{api.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{api.name}</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">{api.description || "No description provided."}</p>
        </div>
        <div className="flex gap-2">
          {detail.canManage && <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button>
                <Upload className="w-4 h-4 mr-2" />
                Import a spec
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Import OpenAPI</DialogTitle>
                <DialogDescription>
                  Upload or paste OpenAPI 3.x JSON or YAML. Imported operations start disabled.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onImportSubmit)} className="space-y-4">
                  <div className="grid gap-2">
                    <FormLabel>File Upload</FormLabel>
                    <Input type="file" accept=".json,.yaml,.yml" onChange={handleFileUpload} />
                  </div>
                  <div className="relative flex items-center py-2">
                    <div className="flex-grow border-t border-muted"></div>
                    <span className="flex-shrink-0 mx-4 text-muted-foreground text-xs uppercase">OR PASTE RAW</span>
                    <div className="flex-grow border-t border-muted"></div>
                  </div>
                  <FormField
                    control={form.control}
                    name="document"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Textarea 
                            placeholder='{"openapi": "3.0.0", "info": {...}}' 
                            className="h-48 font-mono text-xs" 
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button type="submit" disabled={importSpec.isPending}>
                    {importSpec.isPending ? "Importing..." : "Import spec"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>}
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-4 w-4 text-primary" /> Credentials
            </CardTitle>
            <CardDescription>
              API-key and Bearer credentials are encrypted, destination-bound, and injected only for approved HTTPS GETs.
            </CardDescription>
          </div>
          {!detail.canManage && supportedSchemes.length > 0 && (
            <Badge variant="outline" className="w-fit">Member view · owner-managed</Badge>
          )}
        </CardHeader>
        <CardContent className="pt-4">
          {!api.latestSpecification ? (
            <p className="text-sm text-muted-foreground">Import a specification to discover supported credential schemes.</p>
          ) : !supportedSchemes.length ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4" /> No supported API-key or Bearer schemes declared.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {supportedSchemes.map((scheme) => {
                const credential = credentialFor(scheme, credentials)
                const configured = credential?.status === "ACTIVE" && credential.configured
                const revoked = credential?.status === "REVOKED"
                return (
                  <div key={scheme.name} className="flex flex-col gap-3 rounded-md border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-sm">{scheme.name}</span>
                        <Badge variant="outline" className="text-[10px]">{schemeLabel(scheme)}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {configured ? `Configured · ${credential?.label}` : revoked ? "Revoked" : "Not configured"}
                        {credential?.destinationHost ? ` · ${credential.destinationHost}` : ""}
                      </p>
                    </div>
                    {detail.canManage && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => openCredentialDialog(scheme)}>
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {configured ? "Replace" : "Configure"}
                        </Button>
                        {configured && credential && (
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onCredentialRevoke(credential)} disabled={revokeCredential.isPending}>
                            <Ban className="mr-1.5 h-3.5 w-3.5" /> Revoke
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {credentialsLoading && <p className="mt-3 text-xs text-muted-foreground">Loading credential status…</p>}
        </CardContent>
      </Card>

      <Dialog open={credentialOpen} onOpenChange={closeCredentialDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{credentialFor(credentialScheme, credentials) ? "Replace" : "Configure"} {credentialScheme ? schemeLabel(credentialScheme) : "credential"}</DialogTitle>
            <DialogDescription>
              Secret input is write-only. It will be encrypted and cannot be viewed again after saving.
            </DialogDescription>
          </DialogHeader>
          <Form {...credentialForm}>
            <form onSubmit={credentialForm.handleSubmit(onCredentialSubmit)} className="space-y-4">
              <FormField control={credentialForm.control} name="label" render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl><Input autoComplete="off" placeholder="Production gateway key" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={credentialForm.control} name="secret" render={({ field }) => (
                <FormItem>
                  <FormLabel>Secret</FormLabel>
                  <FormControl><Input type="password" autoComplete="new-password" aria-label="Credential secret" placeholder="Enter once; never redisplayed" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="submit" disabled={credentialPending}>
                  {credentialPending ? "Saving…" : "Save credential"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-1 border-t-4 border-t-sidebar-primary">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Specification Health</CardTitle>
          </CardHeader>
          <CardContent>
            {api.latestSpecification ? (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Version</span>
                  <Badge variant="outline" className="font-mono">{api.latestSpecification.version}</Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Format</span>
                  <span className="text-sm font-mono uppercase">{api.latestSpecification.format} ({api.latestSpecification.openapiVersion})</span>
                </div>
                <div className="pt-2 border-t">
                  <span className="text-xs text-muted-foreground block mb-1">Document Hash (SHA-256)</span>
                  <span className="text-[10px] font-mono break-all bg-muted p-1 rounded block text-muted-foreground">
                    {api.latestSpecification.documentHash}
                  </span>
                </div>
                {api.latestSpecification.validationWarnings.length > 0 && (
                  <div className="pt-2 border-t">
                    <span className="text-sm font-medium text-amber-600 flex items-center mb-2">
                      <AlertTriangle className="w-4 h-4 mr-1" />
                      Security Warnings ({api.latestSpecification.validationWarnings.length})
                    </span>
                    <ul className="space-y-2 max-h-32 overflow-y-auto pr-2">
                      {api.latestSpecification.validationWarnings.map((w, i) => (
                        <li key={i} className="text-xs flex items-start">
                          <span className="text-amber-500 mr-1 mt-0.5">•</span>
                          <div>
                            <span className="font-mono block">{w.code}</span>
                            <span className="text-muted-foreground">{w.message}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center p-4">
                <FileCode2 className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-30" />
                <p className="text-sm text-muted-foreground">No specification imported.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2 flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
            <div>
              <CardTitle>Operations</CardTitle>
              <CardDescription>
                {enabledCount} of {totalCount} operations enabled. Execution still requires eligibility and explicit approval.
              </CardDescription>
            </div>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search path or method..."
                className="pl-8 bg-muted/50 font-mono text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardHeader>
          <div className="border-b bg-muted/30 px-6 py-3 text-sm text-muted-foreground">
             Execution support: HTTPS <span className="font-mono text-foreground">GET</span>, no request body, explicit approval required; declared API-key or Bearer credentials are injected only after policy checks.
          </div>
          <div className="flex-1 overflow-auto max-h-[500px]">
            {opsLoading ? (
              <div className="p-6 space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !operations?.length ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <Activity className="w-8 h-8 mb-2 opacity-20" />
                <p className="text-sm">No operations discovered.</p>
                <p className="text-xs">Import a specification to populate the catalog.</p>
              </div>
            ) : filteredOps.length === 0 ? (
              <div className="text-center p-6 text-sm text-muted-foreground">No operations match search.</div>
            ) : (
              <Table>
                <TableHeader className="bg-background sticky top-0 shadow-sm">
                  <TableRow>
                    <TableHead className="w-20">Method</TableHead>
                    <TableHead>Path</TableHead>
                    <TableHead className="w-24 text-center">Status</TableHead>
                    <TableHead className="w-20 text-right">Review</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOps.map((op) => {
                    const anonymous = op.securityGroups.some((group) => group.length === 0) || op.securityGroups.length === 0
                    const supportedCredentialGroup = op.securityGroups.some((group) => group.length > 0 && group.every((requirement) => {
                      const scheme = api.latestSpecification?.securitySchemes.find((item) => item.name === requirement.scheme)
                      return Boolean(scheme && isSupportedScheme(scheme))
                    }))
                    const configuredCredentialGroup = op.securityGroups.some((group) => group.length > 0 && group.every((requirement) => {
                      const scheme = api.latestSpecification?.securitySchemes.find((item) => item.name === requirement.scheme)
                      return Boolean(scheme && isSupportedScheme(scheme) && credentialFor(scheme, credentials)?.status === "ACTIVE")
                    }))
                    const credentialRequired = !anonymous && supportedCredentialGroup
                    const executionSupported = op.method === "GET" && !op.requestBody && (anonymous || configuredCredentialGroup)
                    return (
                    <TableRow key={op.id} className={!op.enabled ? "opacity-70 bg-muted/20" : ""}>
                      <TableCell>
                        <Badge 
                          variant="outline" 
                          className={`font-mono border-0 rounded-sm text-[10px] w-14 justify-center ${METHOD_COLORS[op.method] || "bg-gray-100 text-gray-700"}`}
                        >
                          {op.method}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[200px]" title={op.path}>
                        {op.path}
                        {op.summary && <span className="block text-muted-foreground font-sans text-[10px] truncate max-w-[250px]">{op.summary}</span>}
                      </TableCell>
                      <TableCell className="text-center">
                        {!executionSupported && credentialRequired && !configuredCredentialGroup ? (
                          <span className="inline-flex items-center text-[10px] uppercase font-bold text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                            <Key className="w-3 h-3 mr-1" /> Credential missing
                          </span>
                        ) : !executionSupported ? (
                          <span className="inline-flex items-center text-[10px] uppercase font-bold text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                            <AlertTriangle className="w-3 h-3 mr-1" /> Unsupported
                          </span>
                        ) : op.enabled ? (
                          <span className="inline-flex items-center text-[10px] uppercase font-bold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded">
                             <CheckCircle2 className="w-3 h-3 mr-1" /> {credentialRequired ? "Configured" : "Unauthenticated"}
                          </span>
                        ) : (
                          <span className="inline-flex items-center text-[10px] uppercase font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded">
                            <XCircle className="w-3 h-3 mr-1" /> Blocked
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                          <Link href={`/workspaces/${workspaceId}/apis/${apiId}/operations/${op.id}`}>
                             Review
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
