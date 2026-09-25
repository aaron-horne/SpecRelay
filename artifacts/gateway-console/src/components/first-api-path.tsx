import type { ReactNode } from "react"
import { Link } from "wouter"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

const steps = [
  "Create a workspace",
  "Add an API and import its OpenAPI document",
  "Review operations and enable only what you approve",
  "Add API credentials when needed",
  "Connect your app or AI client through MCP",
  "Review activity and execution logs",
]

export function FirstApiPath({ action }: { action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-5" data-testid="first-api-path">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Getting started</p>
        <h2 className="text-lg font-semibold">Connect your first API</h2>
        <p className="text-sm text-muted-foreground">Start with what your API already does. You choose what clients can access.</p>
      </div>
      <ol className="grid gap-x-6 gap-y-2 text-left sm:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step} className="flex items-start gap-3 text-sm">
            <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-primary/40 font-mono text-[10px] text-primary">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {action}
        <Button variant="ghost" size="sm" asChild>
          <Link href="/how-it-works" data-testid="link-first-api-guide">
            How it works <ArrowRight aria-hidden="true" className="ml-1 size-4" />
          </Link>
        </Button>
      </div>
    </div>
  )
}