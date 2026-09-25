import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { Route, Router } from "wouter"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Shell } from "./layout/shell"
import { FirstApiPath } from "./first-api-path"
import { FAQ_PATH, HOW_IT_WORKS_PATH } from "../guide-routes"
import HowItWorksPage from "../pages/how-it-works"
import FaqPage from "../pages/faq"
import WorkspacesPage from "../pages/workspaces"
import WorkspaceDetailPage from "../pages/workspace-detail"

const overviewState = vi.hoisted(() => ({ canManage: true }))
vi.mock("@workspace/api-client-react", () => ({
  useListWorkspaces: () => ({ data: [], isLoading: false, error: null }),
  useCreateWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
  getListWorkspacesQueryKey: () => ["/api/workspaces"],
  useGetWorkspaceOverview: () => ({
    data: {
      workspace: { name: "Starter workspace" },
      canManage: overviewState.canManage,
      apiCount: 0,
      operationCount: 0,
      enabledOperationCount: 0,
      recentAuditEvents: [],
    },
    isLoading: false,
  }),
  useListApis: () => ({ data: [], isLoading: false }),
  useCreateApi: () => ({ mutate: vi.fn(), isPending: false }),
  getListApisQueryKey: () => ["/api/workspaces/apis"],
  getGetWorkspaceOverviewQueryKey: () => ["/api/workspaces/overview"],
}))
vi.mock("./connector-tokens", () => ({ ConnectorTokens: () => null }))
vi.mock("./delete-workspace-dialog", () => ({ DeleteWorkspaceDialog: () => null }))
vi.mock("./semantic-assistance", () => ({ SemanticAssistance: () => null }))

function renderAt(path: string, content: ReturnType<typeof createElement>) {
  const hook = () => [path, () => undefined] as const
  return renderToStaticMarkup(createElement(Router, { hook }, content))
}

describe("help pages and navigation", () => {
  it("links to both help pages in the existing console shell and marks the active page", () => {
    const html = renderAt(FAQ_PATH, createElement(Shell, null, createElement("div", null, "Content")))
    const faqLink = html.match(/<a[^>]*data-testid="link-faq"[^>]*>/)?.[0]
    const guideLink = html.match(/<a[^>]*data-testid="link-how-it-works"[^>]*>/)?.[0]
    expect(faqLink).toContain(`href="${FAQ_PATH}"`)
    expect(faqLink).toContain('aria-current="page"')
    expect(guideLink).toContain(`href="${HOW_IT_WORKS_PATH}"`)
    expect(guideLink).not.toContain('aria-current="page"')
    expect(html).toContain('href="/console"')
  })

  it("renders the real setup sequence and optional owner-controlled analysis", () => {
    const html = renderAt(HOW_IT_WORKS_PATH, createElement(HowItWorksPage))
    for (const text of ["Create a workspace", "Import your API", "Review and approve", "Add upstream credentials", "Connect an MCP client", "Review activity", "Connect Jev", "mark it Ready", "outbound payload", "accept or reject", "OWNER separately previews and publishes"]) {
      expect(html).toContain(text)
    }
    expect(html).toContain("It never rewrites the imported OpenAPI document")
    expect(html).toContain('href="/faq"')
  })

  it("renders all nine beginner answers, including the connector and re-import boundaries", () => {
    const html = renderAt(FAQ_PATH, createElement(FaqPage))
    expect(html.match(/data-testid="faq-item-/g)).toHaveLength(9)
    for (const question of ["What is SpecRelay?", "Is it an API tester?", "Does SpecRelay create/provide an MCP connector?", "Where do credentials live?", "Can AI automatically enable operations?", "What does Semantic Assistance do?", "Does Jev change my API?", "What happens when an API is re-imported?", "What does Publish to MCP mean?"]) {
      expect(html).toContain(question)
    }
    expect(html).toContain("fresh operations that start disabled and denied")
    expect(html).toContain("It does not edit the imported OpenAPI document")
    expect(html).toContain('href="/how-it-works"')
  })
})

describe("first API onboarding", () => {
  it("shows the same practical sequence and a working guide destination", () => {
    const html = renderAt("/console", createElement(FirstApiPath, {
      action: createElement("button", { type: "button" }, "Create your first workspace"),
    }))
    expect(html).toContain("Connect your first API")
    expect(html.match(/<li /g)).toHaveLength(6)
    expect(html).toContain("Add an API and import its OpenAPI document")
    expect(html).toContain("Connect your app or AI client through MCP")
    expect(html).toContain("Create your first workspace")
    expect(html).toContain(`href="${HOW_IT_WORKS_PATH}"`)
  })

  it("renders the first-time workspace action in the actual empty list", () => {
    const html = renderAt("/console", createElement(QueryClientProvider, {
      client: new QueryClient(),
    }, createElement(WorkspacesPage)))
    expect(html).toContain("Connect your first API")
    expect(html).toContain('data-testid="button-first-workspace"')
    expect(html).toContain("Create your first workspace")
    expect(html).toContain('data-testid="button-new-workspace"')
  })

  it("offers the existing Add API action only to workspace owners", () => {
    const renderWorkspace = () => renderAt("/workspaces/workspace-1", createElement(QueryClientProvider, {
      client: new QueryClient(),
    }, createElement(Route, { path: "/workspaces/:workspaceId", component: WorkspaceDetailPage })))
    overviewState.canManage = true
    expect(renderWorkspace()).toContain('data-testid="button-first-api"')
    overviewState.canManage = false
    const memberHtml = renderWorkspace()
    expect(memberHtml).not.toContain('data-testid="button-first-api"')
    expect(memberHtml).toContain("Ask a workspace OWNER to add the first API")
    overviewState.canManage = true
  })
})