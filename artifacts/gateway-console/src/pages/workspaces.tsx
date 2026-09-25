import { useListWorkspaces, useCreateWorkspace, getListWorkspacesQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Link, useLocation } from "wouter"
import { Plus, LayoutGrid, List, Clock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useToast } from "@/hooks/use-toast"
import { FirstApiPath } from "@/components/first-api-path"
import { useState } from "react"
import { formatDistanceToNow } from "date-fns"

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
})

const WORKSPACE_VIEW_STORAGE_KEY = "specrelay-workspace-view"
type WorkspaceView = "card" | "list"

export default function WorkspacesPage() {
  const { data: workspaces, isLoading, error } = useListWorkspaces()
  const createWorkspace = useCreateWorkspace()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<WorkspaceView>(() => {
    if (typeof window === "undefined") return "card"
    try {
      return window.localStorage.getItem(WORKSPACE_VIEW_STORAGE_KEY) === "list" ? "list" : "card"
    } catch {
      return "card"
    }
  })
  const [, setLocation] = useLocation()

  function changeView(nextView: string) {
    if (nextView !== "card" && nextView !== "list") return
    setView(nextView)
    try {
      window.localStorage.setItem(WORKSPACE_VIEW_STORAGE_KEY, nextView)
    } catch {
      // Preferences are optional; storage may be unavailable in private browsing.
    }
  }

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
    },
  })

  function onSubmit(values: z.infer<typeof formSchema>) {
    createWorkspace.mutate(
      { data: values },
      {
        onSuccess: (newWorkspace) => {
          queryClient.invalidateQueries({ queryKey: getListWorkspacesQueryKey() })
          toast({ title: "Workspace created", description: `Successfully created ${newWorkspace.name}` })
          setOpen(false)
          form.reset()
          setLocation(`/workspaces/${newWorkspace.id}`)
        },
        onError: (err) => {
          toast({ title: "Error", description: err.message || "Failed to create workspace", variant: "destructive" })
        }
      }
    )
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Workspaces</h1>
          <p className="text-muted-foreground mt-1">Import specs and review execution policy.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={changeView}
            variant="outline"
            size="sm"
            aria-label="Workspace view"
            className="rounded-md border border-border bg-card p-1"
          >
            <ToggleGroupItem value="card" aria-label="Card view" data-testid="button-workspace-view-card">
              <LayoutGrid className="mr-2 h-4 w-4" />
              Card
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view" data-testid="button-workspace-view-list">
              <List className="mr-2 h-4 w-4" />
              List
            </ToggleGroupItem>
          </ToggleGroup>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-workspace">
                <Plus className="mr-2 h-4 w-4" />
                New Workspace
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Workspace</DialogTitle>
                <DialogDescription>
                  Group OpenAPI specifications and operation policy in one workspace.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Workspace Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. Production Billing" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button type="submit" disabled={createWorkspace.isPending}>
                      {createWorkspace.isPending ? "Creating..." : "Create Workspace"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-3/4 mb-2" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <div className="p-4 border border-destructive text-destructive rounded-md bg-destructive/10">
          Failed to load workspaces. Please try again.
        </div>
      ) : !workspaces?.length ? (
        <Card className="border-dashed bg-transparent shadow-none">
          <CardContent className="p-6 text-center sm:p-10">
            <FirstApiPath action={
              <Button onClick={() => setOpen(true)} data-testid="button-first-workspace">
                Create your first workspace
              </Button>
            } />
          </CardContent>
        </Card>
      ) : (
        <div className={view === "card" ? "grid gap-4 md:grid-cols-2 lg:grid-cols-3" : "space-y-3"}>
          {workspaces.map((ws) => (
            <Card key={ws.id} className={view === "card"
              ? "hover-elevate transition-shadow group flex flex-col"
              : "hover-elevate transition-shadow"}>
              <CardHeader className={view === "list" ? "flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center" : undefined}>
                <CardTitle className="min-w-0 flex-1 text-base break-words" data-testid={`text-workspace-name-${ws.id}`}>{ws.name}</CardTitle>
                <CardDescription className={view === "list" ? "flex shrink-0 items-center" : "flex items-center mt-2"}>
                  <Clock className="w-3.5 h-3.5 mr-1" />
                  Created {formatDistanceToNow(new Date(ws.createdAt))} ago
                </CardDescription>
                {view === "list" && (
                  <Button variant="secondary" className="shrink-0" asChild>
                    <Link href={`/workspaces/${ws.id}`} data-testid={`link-workspace-${ws.id}`}>Open workspace</Link>
                  </Button>
                )}
              </CardHeader>
              {view === "card" && <div className="flex-1" />}
              {view === "card" && <CardFooter>
                <Button variant="secondary" className="w-full group-hover:bg-primary group-hover:text-primary-foreground transition-colors" asChild>
                  <Link href={`/workspaces/${ws.id}`}>Open workspace</Link>
                </Button>
              </CardFooter>
              }
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
