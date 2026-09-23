import { useState } from "react"
import { useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  getGetWorkspaceOverviewQueryKey,
  getListApisQueryKey,
  getListWorkspacesQueryKey,
  useDeleteWorkspace,
} from "@workspace/api-client-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"

const confirmationSchema = z.object({ name: z.string() })

export function DeleteWorkspaceDialog({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [open, setOpen] = useState(false)
  const [, setLocation] = useLocation()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const deletion = useDeleteWorkspace()
  const form = useForm<z.infer<typeof confirmationSchema>>({
    resolver: zodResolver(confirmationSchema),
    defaultValues: { name: "" },
  })
  const matchesName = form.watch("name") === workspaceName

  function onSubmit(values: z.infer<typeof confirmationSchema>) {
    if (values.name !== workspaceName || deletion.isPending) return
    deletion.mutate({ workspaceId, data: { name: values.name } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListWorkspacesQueryKey() })
        queryClient.removeQueries({ queryKey: getGetWorkspaceOverviewQueryKey(workspaceId) })
        queryClient.removeQueries({ queryKey: getListApisQueryKey(workspaceId) })
        toast({ title: "Workspace deleted", description: `${workspaceName} and its active data were permanently deleted.` })
        form.reset()
        setOpen(false)
        setLocation("/console")
      },
      onError: (error) => {
        toast({
          title: "Workspace not deleted",
          description: error.message || "No changes were made. Please try again.",
          variant: "destructive",
        })
      },
    })
  }

  return (
    <>
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base">Danger zone</CardTitle>
          <CardDescription>Delete this workspace and all of its active data permanently.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setOpen(true)} data-testid="button-open-delete-workspace">
            <Trash2 className="mr-2 h-4 w-4" /> Delete workspace
          </Button>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={(next) => {
        if (deletion.isPending) return
        setOpen(next)
        if (!next) form.reset()
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {workspaceName}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. APIs, specifications, credentials, connector tokens, and access to this workspace
              will be permanently removed. Historical audit and security records are retained, but the workspace
              will no longer be accessible.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type <strong>{workspaceName}</strong> to confirm</FormLabel>
                    <FormControl>
                      <Input autoComplete="off" {...field} data-testid="input-confirm-workspace-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={deletion.isPending} onClick={() => { form.reset(); setOpen(false) }} data-testid="button-cancel-delete-workspace">
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" disabled={!matchesName || deletion.isPending} data-testid="button-confirm-delete-workspace">
                  {deletion.isPending ? "Deleting..." : "Permanently delete workspace"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  )
}