import { Link, useParams } from "wouter"
import { 
  useGetWorkspaceOverview, 
  useListApis, 
  useCreateApi, 
  getListApisQueryKey,
  getGetWorkspaceOverviewQueryKey
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { 
  Plus, 
  Activity, 
  ShieldCheck, 
  ShieldAlert, 
  Database,
  ArrowRight,
  Clock
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
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
import { formatDistanceToNow } from "date-fns"
import { useState } from "react"
import { ConnectorTokens } from "@/components/connector-tokens"
import { DeleteWorkspaceDialog } from "@/components/delete-workspace-dialog"
import { SemanticAssistance } from "@/components/semantic-assistance"
import { FirstApiPath } from "@/components/first-api-path"

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(160),
  description: z.string().max(500).optional(),
})

export default function WorkspaceDetailPage() {
  const { workspaceId } = useParams()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data: overview, isLoading: overviewLoading } = useGetWorkspaceOverview(workspaceId || "")
  const { data: apis, isLoading: apisLoading } = useListApis(workspaceId || "")
  const createApi = useCreateApi()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", description: "" },
  })

  function onSubmit(values: z.infer<typeof formSchema>) {
    if (!workspaceId) return
    createApi.mutate(
      { workspaceId, data: { ...values, description: values.description || null } },
      {
        onSuccess: (newApi) => {
          queryClient.invalidateQueries({ queryKey: getListApisQueryKey(workspaceId) })
          queryClient.invalidateQueries({ queryKey: getGetWorkspaceOverviewQueryKey(workspaceId) })
          toast({ title: "API Source Created", description: `Successfully created ${newApi.name}` })
          setOpen(false)
          form.reset()
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message || "Failed to create API source", variant: "destructive" })
        }
      }
    )
  }

  if (!workspaceId) return null

  if (overviewLoading || apisLoading) {
    return <div className="space-y-6"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /></div>
  }

  if (!overview) {
    return <div className="text-destructive">Failed to load workspace.</div>
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link href="/">Workspaces</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{overview.workspace.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{overview.workspace.name}</h1>
          <p className="text-muted-foreground mt-1">API specs, operation policy, and audit events.</p>
        </div>
        {overview.canManage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add API
              </Button>
            </DialogTrigger>
            <DialogContent>
            <DialogHeader>
              <DialogTitle>Add API</DialogTitle>
              <DialogDescription>
                Create an API, then import an OpenAPI specification.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Core Payments API" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="Internal payment processing routes" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit" disabled={createApi.isPending}>
                    {createApi.isPending ? "Adding..." : "Add API"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Registered APIs</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{overview.apiCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Operations</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{overview.operationCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Enabled Policies</CardTitle>
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">{overview.enabledOperationCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Blocked Operations</CardTitle>
            <ShieldAlert className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
              {overview.operationCount - overview.enabledOperationCount}
            </div>
          </CardContent>
        </Card>
      </div>

      {overview.canManage && <ConnectorTokens workspaceId={workspaceId} />}
      {overview.canManage && <SemanticAssistance workspaceId={workspaceId} />}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="col-span-1 border-t-4 border-t-primary">
          <CardHeader>
            <CardTitle>APIs</CardTitle>
            <CardDescription>OpenAPI specifications in this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {!apis?.length ? (
              <div className="rounded-md border border-dashed bg-muted/30 p-5 text-center" data-testid="empty-workspace-apis">
                <FirstApiPath action={overview.canManage ? (
                  <Button size="sm" onClick={() => setOpen(true)} data-testid="button-first-api">Add your first API</Button>
                ) : undefined} />
                {!overview.canManage && <p className="mt-3 text-xs text-muted-foreground">Ask a workspace OWNER to add the first API.</p>}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Spec Ver</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apis.map((api) => (
                    <TableRow key={api.id} className="group">
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-primary">{api.name}</span>
                          {api.description && <span className="text-xs text-muted-foreground">{api.description}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {api.latestSpecification ? (
                          <Badge variant="outline" className="font-mono">{api.latestSpecification.version}</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">No Spec</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/workspaces/${workspaceId}/apis/${api.id}`}>
                            Open <ArrowRight className="w-3 h-3 ml-2" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Audit Log</CardTitle>
            <CardDescription>Recent policy changes in this boundary.</CardDescription>
          </CardHeader>
          <CardContent>
            {!overview.recentAuditEvents.length ? (
              <p className="text-sm text-muted-foreground">No events recorded.</p>
            ) : (
              <div className="space-y-4">
                {overview.recentAuditEvents.map((evt) => (
                  <div key={evt.id} className="flex items-start justify-between border-b last:border-0 pb-3 last:pb-0">
                    <div>
                      <p className="text-sm font-medium font-mono">[{evt.eventType}]</p>
                      <p className="text-xs text-muted-foreground">
                        {evt.resourceType} <span className="font-mono opacity-70">{evt.resourceId?.split("-")[0]}</span>
                      </p>
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Clock className="w-3 h-3 mr-1" />
                      {formatDistanceToNow(new Date(evt.createdAt))} ago
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {overview.canManage && <DeleteWorkspaceDialog workspaceId={workspaceId} workspaceName={overview.workspace.name} />}
    </div>
  )
}
