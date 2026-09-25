import { Link } from "wouter";
import { ArrowRight, BookOpen, ChevronDown, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useGuideMetadata } from "@/hooks/use-guide-metadata";

const questions = [
  {
    question: "What is SpecRelay?",
    answer: "SpecRelay is a gateway between an OpenAPI document you import and an MCP client. It discovers operations, lets an owner approve a small eligible set, and exposes those as tools through a workspace MCP endpoint.",
  },
  {
    question: "Is it an API tester?",
    answer: "No. Its purpose is controlled MCP exposure of approved API operations, not general-purpose API testing. Audit and execution logs help you review activity.",
  },
  {
    question: "Does SpecRelay create/provide an MCP connector?",
    answer: "Yes. SpecRelay provides a per-workspace MCP endpoint. An OWNER creates a connector token in the workspace; point your MCP client to /api/workspaces/:workspaceId/mcp and authenticate with that token. It is separate from credentials used to call the upstream API.",
  },
  {
    question: "Where do credentials live?",
    answer: "Supported upstream API credentials are stored server-side, encrypted and write-only. They are used where the upstream API requires them; they are not the owner-managed bearer token your MCP client uses to connect to the workspace endpoint.",
  },
  {
    question: "Can AI automatically enable operations?",
    answer: "No. Only an owner can explicitly enable and approve operations, and only eligible HTTPS GET operations without a request body can be exposed as MCP tools. AI suggestions do not change policy or execution.",
  },
  {
    question: "What does Semantic Assistance do?",
    answer: "When available, it helps suggest a description for one operation. First connect Jev, test it and mark it Ready. You review the exact outbound payload and explicitly confirm and send the one-operation analysis. Then you accept or reject the suggestion. An OWNER must separately preview and publish an accepted description for an eligible MCP tool. The feature may be unavailable until rollout is enabled.",
  },
  {
    question: "Does Jev change my API?",
    answer: "No. Jev is used for optional, explicitly sent one-operation analysis. Its suggestion cannot rewrite the imported OpenAPI document, enable an operation, or automatically change execution or policy. AI suggests; the OWNER decides.",
  },
  {
    question: "What happens when an API is re-imported?",
    answer: "If the spec has changed, re-importing creates a new active version with fresh operations that start disabled and denied. Submitting an identical spec is a no-op. Review and approve eligible operations again for the changed version.",
  },
  {
    question: "What does Publish to MCP mean?",
    answer: "After an OWNER accepts a suggested description, publishing it applies a description overlay to that eligible tool in MCP tools/list. It does not edit the imported OpenAPI document, alter approval policy, or change execution behavior.",
  },
] as const;

export default function FaqPage() {
  useGuideMetadata(
    "Frequently asked questions | SpecRelay",
    "Answers to common questions about SpecRelay, OpenAPI imports, MCP connectors, credentials, approvals, and optional Semantic Assistance.",
  );

  return (
    <div className="mx-auto max-w-5xl pb-16 animate-in fade-in duration-500">
      <div className="mb-8 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link href="/console" data-testid="link-faq-workspaces" className="rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Workspaces</Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">FAQ</span>
      </div>

      <header className="mb-10 max-w-3xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded border border-primary/25 bg-primary/5 px-2.5 py-1 font-mono text-[11px] font-medium tracking-wide text-primary">
          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
          FIELD NOTES
        </div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Questions, answered plainly.</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
          What gets imported, what gets exposed, and who makes the final call. Start here if you&apos;re new to SpecRelay.
        </p>
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_250px] lg:gap-12">
        <section aria-label="Frequently asked questions" className="min-w-0">
          <div className="mb-4 flex items-center justify-between border-b pb-3">
            <h2 className="text-sm font-semibold">Common questions</h2>
            <span className="font-mono text-[11px] text-muted-foreground">01—09</span>
          </div>
          <div className="divide-y rounded-md border bg-card">
            {questions.map(({ question, answer }, index) => (
              <details key={question} className="group px-4 open:bg-secondary/20 sm:px-5" data-testid={`faq-item-${index + 1}`}>
                <summary className="flex cursor-pointer list-none items-start gap-3 py-5 text-left outline-none [&::-webkit-details-marker]:hidden focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="mt-0.5 shrink-0 font-mono text-[11px] text-primary">{String(index + 1).padStart(2, "0")}</span>
                  <span className="flex-1 text-sm font-medium leading-5 text-foreground transition-colors group-hover:text-primary sm:text-[15px]">{question}</span>
                  <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <p className="pb-5 pl-8 pr-5 text-sm leading-6 text-muted-foreground">{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <aside className="space-y-4" aria-label="Quick orientation">
          <Card className="border-border bg-card shadow-none">
            <CardContent className="p-5">
              <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </div>
              <h2 className="text-sm font-semibold">The short version</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Importing discovers. Approval exposes. Optional AI can suggest a description, but an OWNER decides whether to publish it.
              </p>
            </CardContent>
          </Card>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-5">
            <p className="text-xs font-medium text-foreground">Prefer the step-by-step path?</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Follow the journey from workspace creation to activity review.</p>
            <Link href="/how-it-works" data-testid="link-faq-how-it-works" className="mt-4 inline-flex items-center gap-2 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              See how it works <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </aside>
      </div>

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <div>
          <p className="text-sm font-medium">Ready to begin?</p>
          <p className="mt-1 text-xs text-muted-foreground">Create a workspace and import your OpenAPI document.</p>
        </div>
        <Button asChild><Link href="/console" data-testid="link-faq-console">Open workspaces<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
      </footer>
    </div>
  );
}