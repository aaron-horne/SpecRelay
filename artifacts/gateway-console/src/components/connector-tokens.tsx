import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

type Token = {
  actorId: string; tokenId: string; name: string; scopes: string[];
  status: string; createdAt: string; expiresAt: string | null;
}
const endpoint = (workspaceId: string) => `/api/workspaces/${workspaceId}/connectors`

export function ConnectorTokens({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<Token[]>([])
  const [available, setAvailable] = useState(false)
  const [name, setName] = useState("")
  const [list, setList] = useState(true)
  const [call, setCall] = useState(false)
  const [expiry, setExpiry] = useState("")
  const [revealed, setRevealed] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch(endpoint(workspaceId), { credentials: "same-origin", cache: "no-store" })
    if (response.status === 404) { setAvailable(false); return }
    if (!response.ok) { setError("Could not load connectors."); return }
    setAvailable(true)
    setItems(await response.json() as Token[])
  }, [workspaceId])
  useEffect(() => { void load() }, [load])
  async function change(path: string, method: string, body?: unknown) {
    setBusy(true); setError("")
    try {
      const response = await fetch(`${endpoint(workspaceId)}${path}`, {
        method, credentials: "same-origin", cache: "no-store",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) throw new Error("Request was rejected. Check your permissions and input.")
      const result = await response.json() as { token?: string }
      if (result.token) setRevealed(result.token)
      setName(""); setExpiry("")
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed.") }
    finally { setBusy(false) }
  }
  if (!available) return null
  return <Card>
    <CardHeader><CardTitle>Connector tokens</CardTitle><CardDescription>Give a headless client access to approved MCP tools in this workspace. Store its token securely; it is shown only once.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {revealed && <div className="rounded border border-amber-500 p-3 space-y-2">
        <p className="text-sm">Copy this token now. It cannot be retrieved later. Anyone with it can use its granted scopes until revoked or expired.</p>
        <code className="block break-all select-all text-xs">{revealed}</code>
        <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(revealed) }}>Copy token</Button>{" "}
        <Button variant="secondary" onClick={() => setRevealed("")}>Done</Button>
      </div>}
      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-sm space-y-1">Client name<Input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="Reporting agent" /></label>
        <label className="text-sm space-y-1">Expires (optional)<Input type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} /></label>
        <label className="text-sm"><input type="checkbox" checked={list} onChange={e => setList(e.target.checked)} /> List tools</label>
        <label className="text-sm"><input type="checkbox" checked={call} onChange={e => setCall(e.target.checked)} /> Call tools</label>
        <Button disabled={busy || !name.trim() || (!list && !call)} onClick={() => void change("", "POST", {
          name: name.trim(), scopes: [...(list ? ["tools:list"] : []), ...(call ? ["tools:call"] : [])],
          expiresAt: expiry ? new Date(expiry).toISOString() : null,
        })}>Create token</Button>
      </div>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <p className="text-xs text-muted-foreground">MCP endpoint: <code>{window.location.origin}/api/workspaces/{workspaceId}/mcp</code>. Send Authorization: Bearer &lt;token&gt; with the required MCP protocol headers. Rotations allow five minutes for cutover; revocation blocks new requests. Calls already dispatched cannot be recalled.</p>
      {items.map(item => <div key={item.tokenId} className="flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <strong>{item.name}</strong><span>{item.status}</span><span>{item.scopes.join(", ")}</span>
        <span className="text-muted-foreground">{item.expiresAt ? `Expires ${new Date(item.expiresAt).toLocaleString()}` : "No expiry"}</span>
        {item.status === "active" && <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(`/${item.actorId}/rotate`, "POST")}>Rotate</Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => {
            if (window.confirm(`Revoke all tokens for ${item.name}?`)) void change(`/${item.actorId}`, "DELETE")
          }}>Revoke</Button>
        </>}
      </div>)}
    </CardContent>
  </Card>
}