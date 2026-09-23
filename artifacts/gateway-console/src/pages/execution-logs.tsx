import { useState, useEffect } from "react"
import { useListExecutionLogs, useListWorkspaces, ExecutionOutcome } from "@workspace/api-client-react"
import { Search, Activity, ShieldAlert, CheckCircle, AlertCircle, Clock, Server } from "lucide-react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

export default function ExecutionLogsPage() {
  const [page, setPage] = useState(1)
  const pageSize = 20
  
  const [workspaceId, setWorkspaceId] = useState<string>("_all")
  const [outcome, setOutcome] = useState<ExecutionOutcome | "_all">("_all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [workspaceId, outcome, debouncedSearch])

  const { data: workspaces } = useListWorkspaces()

  const { data: logsPage, isLoading, error } = useListExecutionLogs({
    page,
    pageSize,
    workspaceId: workspaceId === "_all" ? undefined : workspaceId,
    outcome: outcome === "_all" ? undefined : outcome,
    search: debouncedSearch || undefined
  })

  const getOutcomeBadge = (status: ExecutionOutcome) => {
    switch (status) {
      case ExecutionOutcome.SUCCESS:
        return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1"><CheckCircle className="w-3 h-3" /> Success</Badge>
      case ExecutionOutcome.DENIED:
        return <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/20 gap-1"><ShieldAlert className="w-3 h-3" /> Denied</Badge>
      case ExecutionOutcome.ERROR:
        return <Badge variant="outline" className="bg-rose-500/10 text-rose-400 border-rose-500/20 gap-1"><AlertCircle className="w-3 h-3" /> Error</Badge>
      case ExecutionOutcome.ATTEMPTED:
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 gap-1"><Clock className="w-3 h-3" /> Attempted</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Execution Logs</h1>
        <p className="text-muted-foreground mt-1">Read-only observability for execution audit events across your workspaces.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search logs..."
            className="pl-9 bg-card border-card-border"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-logs"
          />
        </div>
        
        <Select value={workspaceId} onValueChange={setWorkspaceId}>
          <SelectTrigger className="w-[200px] bg-card border-card-border" data-testid="select-workspace-filter">
            <SelectValue placeholder="All Workspaces" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All Workspaces</SelectItem>
            {workspaces?.map(ws => (
              <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={outcome} onValueChange={(value) => setOutcome(value as ExecutionOutcome | "_all")}>
          <SelectTrigger className="w-[160px] bg-card border-card-border" data-testid="select-outcome-filter">
            <SelectValue placeholder="All Outcomes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All Outcomes</SelectItem>
            <SelectItem value={ExecutionOutcome.SUCCESS}>Success</SelectItem>
            <SelectItem value={ExecutionOutcome.DENIED}>Denied</SelectItem>
            <SelectItem value={ExecutionOutcome.ERROR}>Error</SelectItem>
            <SelectItem value={ExecutionOutcome.ATTEMPTED}>Attempted</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border border-card-border rounded-lg bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow className="border-card-border">
              <TableHead className="w-[180px]">Timestamp</TableHead>
              <TableHead className="w-[150px]">Workspace</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead className="w-[200px]">API / Tool</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="w-[190px]">Event</TableHead>
              <TableHead className="w-[140px]">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i} className="border-card-border">
                  <TableCell><Skeleton className="h-4 w-[140px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[200px]" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-[80px]" /></TableCell>
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-rose-400" data-testid="status-execution-logs-error">
                  Failed to load execution logs.
                </TableCell>
              </TableRow>
            ) : logsPage?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-48 text-center" data-testid="status-execution-logs-empty">
                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                    <Activity className="h-10 w-10 mb-4 opacity-20" />
                    <p className="font-medium text-foreground">No execution events found</p>
                    <p className="text-sm mt-1 max-w-md">
                      Execution activity appears here after MCP tools are invoked by your clients. Verify your MCP server connection and tool execution policies.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              logsPage?.items.map((log) => (
                <TableRow key={log.id} className="border-card-border hover:bg-muted/10 transition-colors" data-testid={`row-log-${log.id}`}>
                  <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(log.createdAt), "yyyy-MM-dd HH:mm:ss")}
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    {log.workspaceName}
                  </TableCell>
                  <TableCell className="text-sm">{log.actorLabel}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {log.apiName ? (
                        <div className="flex items-center text-sm font-medium">
                          <Server className="w-3 h-3 mr-1.5 text-primary" />
                          {log.apiName}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">-</span>
                      )}
                      {log.toolName && (
                        <div className="text-xs font-mono text-muted-foreground break-all">
                          {log.toolName}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {log.method && log.path ? (
                      <div className="flex items-center flex-wrap gap-2 text-sm font-mono">
                        <span className="text-primary">{log.method.toUpperCase()}</span>
                        <span className="text-muted-foreground truncate max-w-[250px]" title={log.path}>
                          {log.path}
                        </span>
                        {log.upstreamStatus && (
                          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-mono">
                            {log.upstreamStatus}
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm">{log.eventType}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground" data-testid={`text-event-type-${log.id}`}>
                    {log.eventType}
                  </TableCell>
                  <TableCell>
                    {getOutcomeBadge(log.outcome)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {logsPage && logsPage.totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <div className="text-sm text-muted-foreground" data-testid="text-pagination-info">
            Showing <span className="font-medium text-foreground">{(page - 1) * pageSize + 1}</span> to <span className="font-medium text-foreground">{Math.min(page * pageSize, logsPage.total)}</span> of <span className="font-medium text-foreground">{logsPage.total}</span> logs
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || isLoading}
              className="bg-card border-card-border"
              data-testid="button-prev-page"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= logsPage.totalPages || isLoading}
              className="bg-card border-card-border"
              data-testid="button-next-page"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
