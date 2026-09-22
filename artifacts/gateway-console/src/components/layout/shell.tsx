import { Link, useLocation } from "wouter"
import { Database, LayoutGrid, Activity, HardDrive } from "lucide-react"
import { Logo } from "@/components/ui/logo"

export function Shell({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  const [location] = useLocation()
  
  return (
    <div className="flex min-h-screen flex-col lg:flex-row bg-background">
      <aside className="w-full lg:w-64 border-r bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="h-14 flex items-center px-4 text-sidebar-foreground border-b border-sidebar-border">
          <Logo className="h-7" />
        </div>
        <div className="p-4 flex-1">
          <div className="text-xs font-medium uppercase tracking-wider text-sidebar-foreground/70 mb-3 px-2">Navigation</div>
          <nav className="space-y-1">
            <Link
              href="/"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                location === "/" || location.startsWith("/workspaces")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/50"
              }`}
            >
              <LayoutGrid className="w-4 h-4 mr-3" />
              Workspaces
            </Link>
            <div aria-disabled="true" className="flex items-center px-3 py-2 text-sm font-medium rounded-md text-sidebar-foreground/60 cursor-not-allowed">
              <Database className="w-4 h-4 mr-3" />
              API Sources (Coming Soon)
            </div>
            <Link
              href="/execution-logs"
              data-testid="link-execution-logs"
              className={`flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                location.startsWith("/execution-logs")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/50"
              }`}
            >
              <Activity className="w-4 h-4 mr-3" />
              Execution Logs
            </Link>
          </nav>
        </div>
        <div className="p-4 border-t border-sidebar-border text-xs text-sidebar-foreground/70 font-mono">
          <div className="flex items-center">
            <div className="w-2 h-2 rounded-full bg-green-500 mr-2" />
            SYSTEM_ONLINE
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-h-screen min-w-0">
        <header className="min-h-14 border-b bg-background flex flex-wrap items-center gap-2 px-4 py-2 sm:px-6 sticky top-0 z-10">
          <div className="flex-1" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="px-3 py-1 rounded-full bg-secondary text-xs font-mono font-medium flex items-center border" aria-label="MCP protocol version 2026-07-28">
              <HardDrive className="w-3.5 h-3.5 mr-2" />
              MCP 2026-07-28
            </div>
            {actions}
          </div>
        </header>
        <div className="flex-1 p-6 md:p-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </div>
  )
}
