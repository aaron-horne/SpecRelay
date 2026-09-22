import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  auditEventsTable,
  credentialMetadataTable,
  db,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  validateCredentialEncryptionConfig,
} from "./services/credential-crypto";
import { CredentialService } from "./services/credentials";
import { validateManagedCredentialName } from "@workspace/security";

process.env.SESSION_SECRET ??= "credential-test-key-not-for-production";

async function createWorkspace(name: string): Promise<string> {
  const response = await request(app)
    .post("/api/workspaces")
    .send({ name })
    .expect(201);
  return response.body.id as string;
}

async function createApi(workspaceId: string): Promise<string> {
  const response = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis`)
    .send({ name: `Credential API ${randomUUID()}` })
    .expect(201);
  return response.body.id as string;
}

async function importSecuredApi(workspaceId: string, apiId: string) {
  return request(app)
    .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
    .send({
      document: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Credential API", version: "1.0.0" },
        servers: [{ url: "https://api.example.test/v1" }],
        components: {
          securitySchemes: {
            "x-api-key": { type: "apiKey", in: "header", name: "X-API-Key" },
            bearerAuth: { type: "http", scheme: "bearer" },
            oauth: { type: "oauth2", flows: {} },
          },
        },
        security: [{ "x-api-key": [] }, { bearerAuth: [] }],
        paths: {
          "/records": {
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      }),
    })
    .expect(201);
}

describe.sequential("credential metadata security", () => {
  it("binds encryption to context and rejects unknown key versions", () => {
    const context = {
      workspaceId: "workspace",
      apiId: "api",
      schemeName: "key",
      destinationHost: "api.example.test",
    };
    const encrypted = encryptCredentialSecret("context-secret", context);
    expect(decryptCredentialSecret(encrypted, context)).toBe("context-secret");
    expect(() => decryptCredentialSecret(encrypted, { ...context, apiId: "other-api" }))
      .toThrow();
    expect(() => decryptCredentialSecret({ ...encrypted, keyVersion: 99 }, context))
      .toThrow(/Unknown credential encryption version/);
  });

  it("decrypts credentials encrypted with the previous key after rotation", () => {
    const context = {
      workspaceId: "workspace",
      apiId: "api",
      schemeName: "key",
      destinationHost: "api.example.test",
    };
    const previous = process.env.CREDENTIAL_ENCRYPTION_KEY;
    const previousId = process.env.CREDENTIAL_ENCRYPTION_KEY_ID;
    const previousVersion = process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;
    const priorKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const nextKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
    try {
      process.env.CREDENTIAL_ENCRYPTION_KEY = priorKey;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "credential-key-old";
      process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "7";
      const encrypted = encryptCredentialSecret("rotation-secret", context);
      process.env.CREDENTIAL_ENCRYPTION_KEY = nextKey;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "credential-key-new";
      process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "8";
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = priorKey;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID = "credential-key-old";
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION = "7";
      expect(decryptCredentialSecret(encrypted, context)).toBe("rotation-secret");
    } finally {
      if (previous === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = previous;
      if (previousId === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_ID;
      else process.env.CREDENTIAL_ENCRYPTION_KEY_ID = previousId;
      if (previousVersion === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;
      else process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = previousVersion;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION;
    }
  });

  it("rejects missing and malformed production credential encryption settings", () => {
    const nodeEnv = process.env.NODE_ENV;
    const current = process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      expect(() => validateCredentialEncryptionConfig()).toThrow(/required in production/);
      process.env.CREDENTIAL_ENCRYPTION_KEY = "not-a-key";
      expect(() => validateCredentialEncryptionConfig()).toThrow(/base64-encoded 32-byte/);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (current === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = current;
    }
  });

  it("lazily re-encrypts a previous-key credential through execution", async () => {
    const environmentNames = [
      "CREDENTIAL_ENCRYPTION_KEY",
      "CREDENTIAL_ENCRYPTION_KEY_ID",
      "CREDENTIAL_ENCRYPTION_KEY_VERSION",
      "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS",
      "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID",
      "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION",
    ] as const;
    const saved = new Map(environmentNames.map((name) => [name, process.env[name]]));
    const oldKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const currentKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
    try {
      process.env.CREDENTIAL_ENCRYPTION_KEY = oldKey;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "credential-key-old";
      process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "11";
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION;

      const workspaceId = await createWorkspace(`Rotation ${randomUUID()}`);
      const apiId = await createApi(workspaceId);
      await importSecuredApi(workspaceId, apiId);
      const configured = await request(app)
        .post(`/api/workspaces/${workspaceId}/apis/${apiId}/credentials`)
        .send({ schemeName: "x-api-key", label: "old", secret: "lazy-rotation-secret" })
        .expect(200);
      const before = (await db
        .select()
        .from(credentialMetadataTable)
        .where(eq(credentialMetadataTable.id, configured.body.id))).at(0);
      expect(before).toMatchObject({ keyId: "credential-key-old", keyVersion: 11 });
      expect(before?.secretCiphertext).toBeTruthy();
      const oldCiphertext = before?.secretCiphertext;

      process.env.CREDENTIAL_ENCRYPTION_KEY = currentKey;
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "credential-key-current";
      process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "12";
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = oldKey;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID = "credential-key-old";
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION = "11";

      const result = await new CredentialService().secretForExecution(
        workspaceId,
        apiId,
        configured.body.id as string,
        "api.example.test",
      );
      expect(result.secret).toBe("lazy-rotation-secret");

      const after = (await db
        .select()
        .from(credentialMetadataTable)
        .where(eq(credentialMetadataTable.id, configured.body.id))).at(0);
      expect(after).toMatchObject({ keyId: "credential-key-current", keyVersion: 12 });
      expect(after?.secretCiphertext).toBeTruthy();
      expect(after?.secretCiphertext).not.toBe(oldCiphertext);
      expect(JSON.stringify(after)).not.toContain("lazy-rotation-secret");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects incomplete previous-key configuration", () => {
    const environmentNames = [
      "CREDENTIAL_ENCRYPTION_KEY",
      "CREDENTIAL_ENCRYPTION_KEY_ID",
      "CREDENTIAL_ENCRYPTION_KEY_VERSION",
      "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS",
      "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID",
      "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION",
    ] as const;
    const saved = new Map(environmentNames.map((name) => [name, process.env[name]]));
    const nodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      process.env.CREDENTIAL_ENCRYPTION_KEY = "BQUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiM=";
      process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "credential-key-current";
      process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "13";
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = process.env.CREDENTIAL_ENCRYPTION_KEY;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID;
      process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION = "12";
      expect(() => validateCredentialEncryptionConfig()).toThrow(/incomplete/);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });

  it("rejects unsafe managed credential names", () => {
    expect(validateManagedCredentialName("Authorization", "header", false)).toBe(false);
    expect(validateManagedCredentialName("X-Echo\r\nInjected", "header", false)).toBe(false);
    expect(validateManagedCredentialName("Sec-Fetch-Site", "header", false)).toBe(false);
    expect(validateManagedCredentialName("api_key", "query")).toBe(true);
    expect(validateManagedCredentialName("__proto__", "query")).toBe(false);
    expect(validateManagedCredentialName("Authorization", "header", true)).toBe(true);
    expect(validateManagedCredentialName("X-Token", "header", true)).toBe(false);
  });

  it("parses supported schemes and preserves alternatives without exposing secrets", async () => {
    const workspaceId = await createWorkspace(`Parser ${randomUUID()}`);
    const apiId = await createApi(workspaceId);
    const imported = await importSecuredApi(workspaceId, apiId);
    expect(imported.body.specification.securitySchemes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "x-api-key", type: "apiKey", location: "header" }),
        expect.objectContaining({ name: "bearerAuth", type: "http", bearer: true }),
      ]),
    );
    expect(imported.body.specification.securitySchemes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "oauth" })]),
    );
    expect(imported.body.operations[0].securityGroups).toEqual([
      [{ scheme: "x-api-key", scopes: [] }],
      [{ scheme: "bearerAuth", scopes: [] }],
    ]);
  });

  it("allows owner configuration and replacement, while members can only list safe metadata", async () => {
    const workspaceId = await createWorkspace(`Owner ${randomUUID()}`);
    const apiId = await createApi(workspaceId);
    await importSecuredApi(workspaceId, apiId);
    const memberId = `member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({
      workspaceId,
      userId: memberId,
      role: "MEMBER",
    });

    await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/credentials`)
      .set("x-test-user-id", memberId)
      .send({ schemeName: "x-api-key", label: "member", secret: "member-secret" })
      .expect(403);

    const configured = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/credentials`)
      .send({ schemeName: "x-api-key", label: "primary", secret: "first-secret" })
      .expect(200);
    expect(configured.body).toMatchObject({
      schemeName: "x-api-key",
      type: "API_KEY",
      location: "header",
      parameterName: "X-API-Key",
      configured: true,
    });
    expect(JSON.stringify(configured.body)).not.toContain("first-secret");

    const replaced = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/credentials`)
      .send({ schemeName: "x-api-key", label: "rotated", secret: "second-secret" })
      .expect(200);
    expect(replaced.body.id).toBe(configured.body.id);
    expect(replaced.body.label).toBe("rotated");

    const listed = await request(app)
      .get(`/api/workspaces/${workspaceId}/apis/${apiId}/credentials`)
      .set("x-test-user-id", memberId)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toMatch(/first-secret|second-secret|ciphertext|authTag|secretIv/i);

    const stored = await db
      .select()
      .from(credentialMetadataTable)
      .where(
        and(
          eq(credentialMetadataTable.workspaceId, workspaceId),
          eq(credentialMetadataTable.apiId, apiId),
        ),
      );
    expect(stored[0]?.secretCiphertext).toBeTruthy();
    expect(stored[0]?.secretCiphertext).not.toContain("second-secret");

    await request(app)
      .delete(`/api/workspaces/${workspaceId}/apis/${apiId}/credentials/${configured.body.id}`)
      .send()
      .expect(200);
    const events = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.workspaceId, workspaceId));
    const credentialEvents = events.filter((event) => event.eventType.startsWith("credential."));
    expect(credentialEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["credential.configured", "credential.replaced", "credential.revoked"]),
    );
    expect(JSON.stringify(credentialEvents)).not.toMatch(/first-secret|second-secret|ciphertext|authTag|secretIv/i);
  });

  it("isolates credentials by workspace and API source", async () => {
    const workspaceA = await createWorkspace(`Isolation A ${randomUUID()}`);
    const workspaceB = await createWorkspace(`Isolation B ${randomUUID()}`);
    const apiA = await createApi(workspaceA);
    const apiB = await createApi(workspaceB);
    await importSecuredApi(workspaceA, apiA);
    await importSecuredApi(workspaceB, apiB);

    await request(app)
      .post(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`)
      .send({ schemeName: "x-api-key", label: "a", secret: "a-secret" })
      .expect(200);
    await request(app)
      .get(`/api/workspaces/${workspaceB}/apis/${apiA}/credentials`)
      .expect(404);
    await request(app)
      .get(`/api/workspaces/${workspaceA}/apis/${apiB}/credentials`)
      .expect(404);
    await request(app)
      .post(`/api/workspaces/${workspaceB}/apis/${apiB}/credentials`)
      .send({ schemeName: "oauth", label: "bad", secret: "bad-secret" })
      .expect(400);
  });
});