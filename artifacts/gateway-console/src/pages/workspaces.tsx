import { useListWorkspaces, useCreateWorkspace, getListWorkspacesQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Link, useLocation } from "wouter"
import { Plus, LayoutGrid, Clock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { useState } from "react"
import { formatDistanceToNow } from "date-fns"

const formSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
})

export default function WorkspacesPage() {
  const { data: workspaces, isLoading, error } = useListWorkspaces()
  const createWorkspace = useCreateWorkspace()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [, setLocation] = useLocation()

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
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
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
          <CardContent className="flex flex-col items-center justify-center p-12 text-center">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <LayoutGrid className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No workspaces found</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-sm">
              Create a workspace, then import an OpenAPI document.
            </p>
            <Button onClick={() => setOpen(true)} variant="outline">Create your first workspace</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <Card key={ws.id} className="hover-elevate transition-shadow group flex flex-col">
              <CardHeader>
                <CardTitle className="text-base break-words">{ws.name}</CardTitle>
                <CardDescription className="flex items-center mt-2">
                  <Clock className="w-3.5 h-3.5 mr-1" />
                  Created {formatDistanceToNow(new Date(ws.createdAt))} ago
                </CardDescription>
              </CardHeader>
              <div className="flex-1" />
              <CardFooter>
                <Button variant="secondary" className="w-full group-hover:bg-primary group-hover:text-primary-foreground transition-colors" asChild>
                  <Link href={`/workspaces/${ws.id}`}>Open workspace</Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
