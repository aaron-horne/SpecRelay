import { describe, expect, it } from "vitest";
import {
  OpenApiValidationError,
  SecureOpenApiAdapter,
  hashOpenApiDocument,
} from "./index";

const adapter = new SecureOpenApiAdapter();

const minimal = {
  openapi: "3.1.0",
  info: { title: "Example", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        summary: "<script>alert('x')</script>",
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createItem",
        responses: { "201": { description: "created" } },
      },
    },
  },
};

describe("secure OpenAPI ingestion", () => {
  it("accepts JSON and preserves descriptions as inert data", () => {
    const result = adapter.parseAndNormalize(JSON.stringify(minimal));
    expect(result.format).toBe("json");
    expect(result.definition.operations).toHaveLength(2);
    expect(result.definition.operations[0]?.summary).toContain("<script>");
    expect(result.definition.operations[0]?.risk).toBe("READ_LIKE");
    expect(result.definition.operations[1]?.risk).toBe("WRITE");
  });

  it("accepts safe YAML", () => {
    const result = adapter.parseAndNormalize(`
openapi: 3.0.3
info:
  title: Example
  version: 1.0.0
paths:
  /items:
    get:
      responses:
        "200":
          description: ok
`);
    expect(result.format).toBe("yaml");
    expect(result.definition.operations[0]?.risk).toBe("READ_LIKE");
  });

  it.each([
    ["{not-json", "MALFORMED_JSON"],
    ["openapi: [", "MALFORMED_YAML"],
  ])("rejects malformed input", (document, code) => {
    expect(() => adapter.parseAndNormalize(document)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects oversized input before parsing", () => {
    expect(() =>
      adapter.parseAndNormalize(JSON.stringify(minimal), { maxBytes: 20 }),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_TOO_LARGE" }));
  });

  it("rejects excessive nesting", () => {
    const nested = structuredClone(minimal) as Record<string, unknown>;
    let current: Record<string, unknown> = {};
    nested.components = current;
    for (let index = 0; index < 20; index += 1) {
      current.next = {};
      current = current.next as Record<string, unknown>;
    }
    expect(() =>
      adapter.parseAndNormalize(JSON.stringify(nested), { maxDepth: 10 }),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_TOO_DEEP" }));
  });

  it("blocks remote references without fetching", () => {
    const document = structuredClone(minimal) as Record<string, unknown>;
    document.components = {
      schemas: {
        Item: { $ref: "https://attacker.invalid/schema.json" },
      },
    };
    expect(() => adapter.parseAndNormalize(JSON.stringify(document))).toThrowError(
      expect.objectContaining({ code: "REMOTE_REFERENCE_BLOCKED" }),
    );
  });

  it("detects internal reference cycles without dereferencing", () => {
    const document = {
      ...minimal,
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/A" },
        },
      },
    };
    const result = adapter.parseAndNormalize(JSON.stringify(document));
    expect(result.definition.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "REFERENCE_CYCLE" }),
      ]),
    );
  });

  it("warns on duplicate and supports missing operationIds", () => {
    const document = {
      ...minimal,
      paths: {
        "/a": { get: { operationId: "same", responses: {} } },
        "/b": {
          get: { operationId: "same", responses: {} },
          connect: { responses: {} },
        },
      },
    };
    const result = adapter.parseAndNormalize(JSON.stringify(document));
    expect(result.definition.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_OPERATION_ID" }),
      ]),
    );
    expect(result.definition.operations[2]?.risk).toBe("UNKNOWN");
    expect(result.definition.operations[2]?.displayName).toBe("CONNECT b");
  });

  it("rejects YAML alias expansion", () => {
    expect(() =>
      adapter.parseAndNormalize(`
openapi: 3.1.0
info: &info
  title: Example
  version: 1.0.0
paths: {}
copy: *info
`),
    ).toThrowError(OpenApiValidationError);
  });

  it("rejects custom YAML tags", () => {
    expect(() =>
      adapter.parseAndNormalize(`
openapi: 3.1.0
info:
  title: !custom Example
  version: 1.0.0
paths: {}
`),
    ).toThrowError(
      expect.objectContaining({ code: "MALFORMED_YAML" }),
    );
  });

  it("hashes specifications deterministically", () => {
    const document = JSON.stringify(minimal);
    expect(hashOpenApiDocument(document)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpenApiDocument(document)).toBe(hashOpenApiDocument(document));
  });
});