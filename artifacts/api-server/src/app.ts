import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { OpenApiValidationError } from "@workspace/openapi";
import { ServiceError } from "./services/errors";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { securityServices } from "./services/security";
import { shouldInstallClerkMiddleware } from "./middlewares/auth";
import {
  recordSemanticAnalysisDenial,
  semanticAnalysisRequestCategory,
} from "./services/semantic-analysis-denial-audit";

const app: Express = express();
app.locals.security = securityServices;

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json({ limit: "2100kb", strict: true }));
if (shouldInstallClerkMiddleware(process.env.NODE_ENV)) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

app.use("/api", router);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found", code: "ROUTE_NOT_FOUND" });
});

app.use(
  async (
    error: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ): Promise<void> => {
    const isMcpRequest = req.path.endsWith("/mcp");
    const semanticRequest = semanticAnalysisRequestCategory(req.method, req.path);
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (semanticRequest && (status === 400 || status === 413)) {
      await recordSemanticAnalysisDenial(null, semanticRequest, "request_rejected");
    }
    if (error instanceof OpenApiValidationError) {
      res.status(error.code === "DOCUMENT_TOO_LARGE" ? 413 : 400).json({
        error: error.message,
        code: error.code,
        details: [...error.details],
      });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        details: [...error.details],
      });
      return;
    }
    if (
      error instanceof SyntaxError &&
      "status" in error &&
      error.status === 400
    ) {
      if (isMcpRequest) {
        res.status(400).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }
      res.status(400).json({ error: "Malformed JSON", code: "MALFORMED_JSON" });
      return;
    }
    req.log.error({ err: error }, "Unhandled request error");
    if (isMcpRequest) {
      const body = req.body as { id?: unknown } | undefined;
      const id = typeof body?.id === "string" || typeof body?.id === "number"
        ? body.id
        : null;
      res.status(500).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Internal error" },
      });
      return;
    }
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  },
);

export default app;
