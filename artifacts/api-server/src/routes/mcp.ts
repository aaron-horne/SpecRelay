import { Router, type IRouter, type Request, type Response } from "express";
import { actorId, requireWorkspaceMembership } from "../middlewares/auth";
import { McpService } from "../services/execution";
import { ServiceError } from "../services/errors";

const router: IRouter = Router();
const service = new McpService();

const PROTOCOL_VERSION = "2026-07-28";
const CACHE_TTL_MS = 0;
const SERVER_INFO = { name: "SpecRelay", version: "1.0.0" } as const;

type JsonRpcId = string | number;
type RequestMeta = {
  "io.modelcontextprotocol/protocolVersion"?: unknown;
  "io.modelcontextprotocol/clientInfo"?: unknown;
  "io.modelcontextprotocol/clientCapabilities"?: unknown;
};
type McpRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: {
    name?: unknown;
    arguments?: unknown;
    _meta?: RequestMeta;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(body: McpRequest): JsonRpcId | null {
  return typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
}

function sendError(
  res: Response,
  status: number,
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  res.status(status).type("application/json").json({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  });
}

function validateOrigin(req: Request, res: Response, id: JsonRpcId | null): boolean {
  const origin = req.header("origin");
  if (!origin) return true;
  try {
    if (new URL(origin).host === req.header("host")) return true;
  } catch {
    // Rejected below.
  }
  sendError(res, 403, id, -32000, "Invalid Origin header");
  return false;
}

function validateMetadata(req: Request, res: Response, body: McpRequest): boolean {
  const id = requestId(body);
  const params = body.params;
  const meta = isRecord(params?._meta) ? params._meta : undefined;
  const versionHeader = req.header("mcp-protocol-version");
  const methodHeader = req.header("mcp-method");
  const nameHeader = req.header("mcp-name");
  const bodyVersion = meta?.["io.modelcontextprotocol/protocolVersion"];

  if (typeof versionHeader !== "string" || typeof methodHeader !== "string") {
    sendError(res, 400, id, -32020, "Missing required MCP request headers");
    return false;
  }
  if (versionHeader !== bodyVersion || methodHeader !== body.method) {
    sendError(res, 400, id, -32020, "MCP request headers do not match the JSON-RPC body");
    return false;
  }
  if (versionHeader !== PROTOCOL_VERSION) {
    sendError(res, 400, id, -32021, "Unsupported MCP protocol version", {
      supportedVersions: [PROTOCOL_VERSION],
    });
    return false;
  }
  if (body.method === "tools/call" && (typeof params?.name !== "string" || nameHeader !== params.name)) {
    sendError(res, 400, id, -32020, "Mcp-Name header does not match the JSON-RPC body");
    return false;
  }
  if (body.method !== "tools/call" && nameHeader !== undefined) {
    sendError(res, 400, id, -32020, "Mcp-Name header is not valid for this method");
    return false;
  }
  const capabilities = meta?.["io.modelcontextprotocol/clientCapabilities"];
  if (!isRecord(capabilities)) {
    sendError(res, 400, id, -32602, "Request _meta must include client capabilities");
    return false;
  }
  const clientInfo = meta?.["io.modelcontextprotocol/clientInfo"];
  if (
    clientInfo !== undefined &&
    (!isRecord(clientInfo) ||
      typeof clientInfo.name !== "string" ||
      typeof clientInfo.version !== "string")
  ) {
    sendError(res, 400, id, -32602, "Client identity metadata is invalid");
    return false;
  }
  return true;
}

router.post("/workspaces/:workspaceId/mcp", requireWorkspaceMembership, async (req, res): Promise<void> => {
  const body = (isRecord(req.body) ? req.body : {}) as McpRequest;
  const id = requestId(body);
  if (!validateOrigin(req, res, id)) return;

  if (
    body.jsonrpc !== "2.0" ||
    id === null ||
    typeof body.method !== "string" ||
    !isRecord(body.params)
  ) {
    sendError(res, 400, id, -32600, "Invalid Request");
    return;
  }
  if (!validateMetadata(req, res, body)) return;

  if (!["server/discover", "tools/list", "tools/call"].includes(body.method)) {
    sendError(res, 404, id, -32601, "Method not found");
    return;
  }

  if (body.method === "server/discover") {
    res.type("application/json").json({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
         instructions: "Lists and invokes explicitly approved HTTPS GET operations, optionally using configured OpenAPI API-key or Bearer credentials.",
        ttlMs: CACHE_TTL_MS,
        cacheScope: "private",
      },
    });
    return;
  }

  const workspaceId = String(req.params.workspaceId);
  if (body.method === "tools/list") {
    res.type("application/json").json({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        tools: await service.listTools(workspaceId, actorId(req)),
        ttlMs: CACHE_TTL_MS,
        cacheScope: "private",
      },
    });
    return;
  }

  if (
    typeof body.params.name !== "string" ||
    (body.params.arguments !== undefined && !isRecord(body.params.arguments))
  ) {
    sendError(res, 400, id, -32602, "Invalid tool arguments");
    return;
  }

  try {
    const result = await service.callTool(
      workspaceId,
      actorId(req),
      body.params.name,
      (body.params.arguments ?? {}) as Record<string, unknown>,
    );
    const isError = result.status >= 400;
    res.type("application/json").json({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: result.body }],
        structuredContent: { status: result.status, headers: result.headers },
        isError,
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      const code = error.code === "MCP_TOOL_NOT_FOUND" ? -32602 : -32000;
      sendError(res, error.status, id, code, error.message, { code: error.code });
      return;
    }
    throw error;
  }
});

export default router;