import { useEffect, useRef, type ReactNode } from "react";
import { ClerkProvider, Show, SignIn, SignUp, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, Redirect, Link, useLocation, Router as WouterRouter } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { Shell } from "@/components/layout/shell";
import NotFound from "@/pages/not-found";
import WorkspacesPage from "@/pages/workspaces";
import WorkspaceDetailPage from "@/pages/workspace-detail";
import ApiDetailPage from "@/pages/api-detail";
import OperationDetailPage from "@/pages/operation-detail";

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#32C5FF",
    colorForeground: "#F5F7FA",
    colorMutedForeground: "#82909D",
    colorDanger: "#F25F74",
    colorBackground: "#0B0D10",
    colorInput: "#11151A",
    colorInputForeground: "#F5F7FA",
    colorNeutral: "#252B33",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#11151A] rounded-xl w-[440px] max-w-full overflow-hidden border border-[#252B33] shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#F5F7FA]", headerSubtitle: "text-[#82909D]",
    socialButtonsBlockButtonText: "text-[#F5F7FA]", formFieldLabel: "text-[#F5F7FA]",
    footerActionLink: "text-[#32C5FF]", footerActionText: "text-[#82909D]",
    dividerText: "text-[#82909D]", identityPreviewEditButton: "text-[#32C5FF]",
    formFieldSuccessText: "text-emerald-400", alertText: "text-rose-300",
    logoBox: "h-10", logoImage: "h-10",
    socialButtonsBlockButton: "border-[#252B33] bg-[#0B0D10]", formButtonPrimary: "bg-[#32C5FF] hover:bg-[#66D5FF] text-[#0B0D10]",
    formFieldInput: "border-[#252B33] bg-[#0B0D10] text-[#F5F7FA]",
    footerAction: "text-[#82909D]", dividerLine: "bg-[#252B33]",
    alert: "bg-rose-950/30 border-rose-900", otpCodeFieldInput: "border-[#252B33]",
    formFieldRow: "text-[#F5F7FA]", main: "text-[#F5F7FA]",
  },
};

function CacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const next = user?.id ?? null;
    if (previous.current !== undefined && previous.current !== next) client.clear();
    previous.current = next;
  }), [addListener, client]);
  return null;
}

function Landing() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/console" /></Show>
      <Show when="signed-out">
        <main className="min-h-screen bg-background text-foreground grid place-items-center px-6">
          <div className="max-w-2xl text-center space-y-6">
            <Logo className="h-14 justify-center text-white" />
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-primary">Open-source API infrastructure</p>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">OpenAPI in. Governed MCP tools out.</h1>
             <p className="text-base text-muted-foreground sm:text-lg">Import a spec. Review operations. Configure API keys or Bearer tokens. Approve eligible GETs. Expose via MCP. Audit execution.</p>
            <div className="flex flex-wrap justify-center gap-2 text-xs">
              <span className="rounded border bg-secondary px-2 py-1 font-mono">GET only</span>
               <span className="rounded border bg-secondary px-2 py-1">API key + Bearer</span>
              <span className="rounded border bg-secondary px-2 py-1">No request body</span>
              <span className="rounded border bg-secondary px-2 py-1 font-mono">MCP 2026-07-28</span>
            </div>
            <div className="flex justify-center gap-3">
              <Button asChild><Link href="/sign-up">Create account</Link></Button>
              <Button variant="outline" className="bg-transparent" asChild><Link href="/sign-in">Sign in</Link></Button>
            </div>
          </div>
        </main>
      </Show>
    </>
  );
}

function ProtectedConsole() {
  const { signOut } = useClerk();
  return (
    <>
      <Show when="signed-out"><Redirect to="/" /></Show>
      <Show when="signed-in">
        <Shell actions={<Button variant="outline" size="sm" onClick={() => signOut({ redirectUrl: basePath || "/" })}>Sign out</Button>}>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/console" component={WorkspacesPage} />
              <Route path="/workspaces/:workspaceId" component={WorkspaceDetailPage} />
              <Route path="/workspaces/:workspaceId/apis/:apiId" component={ApiDetailPage} />
              <Route path="/workspaces/:workspaceId/apis/:apiId/operations/:operationId" component={OperationDetailPage} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
        </Shell>
      </Show>
    </>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Routes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{ signIn: { start: { title: "Sign in", subtitle: "Open the SpecRelay console" } }, signUp: { start: { title: "Create account", subtitle: "Create a workspace and import OpenAPI" } } }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <CacheInvalidator />
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/sign-in/*?">{() => <div className="min-h-screen bg-background grid place-items-center p-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>}</Route>
        <Route path="/sign-up/*?">{() => <div className="min-h-screen bg-background grid place-items-center p-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>}</Route>
        <Route><ProtectedConsole /></Route>
      </Switch>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={basePath}><Routes /></WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}