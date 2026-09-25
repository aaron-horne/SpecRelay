import { Link } from "wouter";
import { ArrowRight, Check, CircleHelp, FileJson2, LockKeyhole, Route, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGuideMetadata } from "@/hooks/use-guide-metadata";

const steps = [
  {
    number: "01",
    title: "Create a workspace",
    description: "Start with a workspace for the API you want to make available. It keeps the imported document, operation decisions, and connector together.",
    tag: "START HERE",
  },
  {
    number: "02",
    title: "Import your API",
    description: "Add an API and import its OpenAPI 3.x document in JSON or YAML. SpecRelay discovers the operations in that document; importing does not expose them.",
    tag: "OPENAPI 3.x",
  },
  {
    number: "03",
    title: "Review and approve",
    description: "Inspect the discovered operations, then enable and approve only the ones you intend to expose. Only eligible HTTPS GET operations without a request body can become MCP tools.",
    tag: "OWNER DECISION",
  },
  {
    number: "04",
    title: "Add upstream credentials",
    description: "If the API requires authentication, add its supported upstream API credentials on the API page. They are stored server-side, encrypted and write-only; they are not your MCP client token.",
    tag: "IF NEEDED",
  },
  {
    number: "05",
    title: "Connect an MCP client",
    description: "As an OWNER, create a connector token in the workspace. Configure your MCP client to use the workspace endpoint below with that token.",
    tag: "CONNECT",
  },
  {
    number: "06",
    title: "Review activity",
    description: "Use audit and execution logs to review decisions and tool activity after connecting. Approval is deliberate; visibility does not end at setup.",
    tag: "STAY INFORMED",
  },
] as const;

const assistanceSteps = [
  "Connect Jev, test the connection, and mark it Ready.",
  "Review the exact outbound payload for one-operation analysis, then explicitly confirm and send it.",
  "Review the suggestion and accept or reject it.",
  "For an accepted description on an eligible MCP tool, an OWNER separately previews and publishes it.",
] as const;

export default function HowItWorksPage() {
  useGuideMetadata(
    "How it works | SpecRelay",
    "A step-by-step guide to importing OpenAPI, approving eligible operations, connecting an MCP client, and reviewing activity with SpecRelay.",
  );

  return (
    <div className="mx-auto max-w-5xl pb-16 animate-in fade-in duration-500">
      <div className="mb-8 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link href="/console" data-testid="link-guide-workspaces" className="rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Workspaces</Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">How it works</span>
      </div>

      <header className="mb-10 max-w-3xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded border border-primary/25 bg-primary/5 px-2.5 py-1 font-mono text-[11px] font-medium tracking-wide text-primary">
          <Route className="h-3.5 w-3.5" aria-hidden="true" />
          THE OWNER&apos;S PATH
        </div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">From API document to approved tools.</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
          SpecRelay is a gateway, not an automatic exporter. You import an OpenAPI document, decide which eligible operations to expose, and connect your MCP client to a workspace endpoint.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-12">
        <section aria-labelledby="journey-heading" className="min-w-0">
          <div className="mb-5 flex items-center justify-between gap-3 border-b pb-3">
            <h2 id="journey-heading" className="text-sm font-semibold text-foreground">The setup journey</h2>
            <span className="font-mono text-[11px] text-muted-foreground">SIX STEPS</span>
          </div>
          <ol className="relative ml-4 border-l border-border">
            {steps.map((step) => (
              <li key={step.number} className="relative pb-9 pl-8 last:pb-2">
                <span className="absolute -left-[17px] top-0 flex h-8 w-8 items-center justify-center rounded-md border border-primary/40 bg-background font-mono text-[11px] font-semibold text-primary">
                  {step.number}
                </span>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-base font-semibold tracking-tight">{step.title}</h3>
                  <span className="font-mono text-[10px] tracking-wider text-muted-foreground">{step.tag}</span>
                </div>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{step.description}</p>
                {step.number === "05" && (
                  <div className="mt-4 overflow-x-auto rounded-md border border-border bg-secondary/50 px-4 py-3">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Workspace MCP endpoint</div>
                    <code className="whitespace-nowrap font-mono text-xs text-foreground">/api/workspaces/:workspaceId/mcp</code>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">Authenticate with the owner-managed client bearer token, separate from any stored upstream API credentials.</p>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <aside className="space-y-4 lg:pt-1" aria-label="Important boundaries">
          <Card className="border-border bg-card shadow-none">
            <CardHeader className="pb-2">
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary"><FileJson2 className="h-4 w-4" aria-hidden="true" /></div>
              <CardTitle className="text-sm">Import is not approval</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              Discovered operations stay under owner control. Only explicitly approved, eligible HTTPS GET operations without a body can be exposed.
            </CardContent>
          </Card>
          <Card className="border-border bg-card shadow-none">
            <CardHeader className="pb-2">
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary"><LockKeyhole className="h-4 w-4" aria-hidden="true" /></div>
              <CardTitle className="text-sm">Two distinct credentials</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              Your MCP client bearer token grants access to the workspace endpoint. Upstream credentials are used server-side to call your API.
            </CardContent>
          </Card>
        </aside>
      </div>

      <section aria-labelledby="assistance-heading" className="mt-10 border-t pt-9">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2 font-mono text-[11px] tracking-wider text-primary">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              OPTIONAL · WHEN AVAILABLE
            </div>
            <h2 id="assistance-heading" className="text-xl font-semibold tracking-tight sm:text-2xl">Semantic Assistance</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              A review path for tool descriptions, not an automatic policy change. This feature may be unavailable until its rollout is enabled.
            </p>
          </div>
          <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs font-medium text-primary">AI suggests. OWNER decides.</div>
        </div>
        <Card className="bg-card shadow-none">
          <CardContent className="grid gap-0 p-0 sm:grid-cols-2">
            {assistanceSteps.map((step, index) => (
              <div key={step} className={`flex gap-3 p-5 ${index < 3 ? "border-b" : ""} ${index === 2 ? "sm:border-b-0" : ""} ${index % 2 === 0 ? "sm:border-r" : ""}`}>
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-primary/40 font-mono text-[10px] text-primary">{index + 1}</span>
                <p className="text-sm leading-6 text-foreground/85">{step}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          Publishing changes the MCP tools/list description overlay only. It never rewrites the imported OpenAPI document or automatically changes policy or execution.
        </p>
      </section>

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <div>
          <p className="text-sm font-medium">Ready to get oriented?</p>
          <p className="mt-1 text-xs text-muted-foreground">Start with a workspace, or read the common questions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/faq" data-testid="link-guide-faq"><CircleHelp className="mr-2 h-4 w-4" />Read the FAQ</Link></Button>
          <Button asChild><Link href="/console" data-testid="link-guide-console">Open workspaces<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
        </div>
      </footer>
    </div>
  );
}