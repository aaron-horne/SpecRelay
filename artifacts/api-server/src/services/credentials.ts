import { and, desc, eq } from "drizzle-orm";
import {
  apiSourcesTable,
  apiSpecVersionsTable,
  auditEventsTable,
  credentialMetadataTable,
  db,
} from "@workspace/db";
import {
  encryptCredentialSecret,
  decryptCredentialSecret,
  isCurrentCredentialKey,
} from "./credential-crypto";
import { validateManagedCredentialName } from "@workspace/security";
import { ServiceError } from "./errors";
import type { ApiSecurityScheme } from "@workspace/core";

type SupportedScheme = {
  name: string;
  type: "apiKey" | "http";
  location: "header" | "query";
  parameterName: string;
  bearer: boolean;
};

function safeCredential(row: typeof credentialMetadataTable.$inferSelect) {
  return {
    id: row.id,
    schemeName: row.schemeName,
    type: row.credentialType,
    location: row.location,
    parameterName: row.parameterName,
    label: row.label,
    configured: row.status === "ACTIVE",
    status: row.status,
    destinationHost: row.destinationHost,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function latestSpec(workspaceId: string, apiId: string) {
  const [spec] = await db
    .select()
    .from(apiSpecVersionsTable)
    .where(
      and(
        eq(apiSpecVersionsTable.workspaceId, workspaceId),
        eq(apiSpecVersionsTable.apiId, apiId),
        eq(apiSpecVersionsTable.isActive, true),
      ),
    )
    .limit(1);
  if (!spec) {
    throw new ServiceError("Import an OpenAPI specification first", 400, "SPECIFICATION_REQUIRED");
  }
  return spec;
}

async function requireApi(workspaceId: string, apiId: string): Promise<void> {
  const [api] = await db
    .select({ id: apiSourcesTable.id })
    .from(apiSourcesTable)
    .where(
      and(
        eq(apiSourcesTable.workspaceId, workspaceId),
        eq(apiSourcesTable.id, apiId),
      ),
    )
    .limit(1);
  if (!api) throw new ServiceError("API source not found", 404, "API_NOT_FOUND");
}

function destinationHost(serverUrls: readonly string[]): string {
  for (const value of serverUrls) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname && !url.username && !url.password) {
        return url.host.toLowerCase();
      }
    } catch {
      // Ignore invalid server URLs; the broker validates destinations separately.
    }
  }
  throw new ServiceError(
    "The latest specification must declare an HTTPS server",
    400,
    "HTTPS_SERVER_REQUIRED",
  );
}

function declaredScheme(
  spec: Awaited<ReturnType<typeof latestSpec>>,
  schemeName: string,
): SupportedScheme {
  const schemes = (spec.securitySchemes ?? []) as Array<Record<string, unknown>>;
  const scheme = schemes.find((item) => item.name === schemeName);
  if (
    !scheme ||
    (scheme.type !== "apiKey" && scheme.type !== "http") ||
    (scheme.location !== "header" && scheme.location !== "query") ||
    typeof scheme.parameterName !== "string"
  ) {
    throw new ServiceError(
      "The requested credential scheme is unsupported or not declared",
      400,
      "UNSUPPORTED_SECURITY_SCHEME",
    );
  }
  if (scheme.type === "http" && !scheme.bearer) {
    throw new ServiceError(
      "Only Bearer-token HTTP authentication is supported",
      400,
      "UNSUPPORTED_SECURITY_SCHEME",
    );
  }
  if (scheme.type === "http" && scheme.location !== "header") {
    throw new ServiceError(
      "Bearer tokens must use the Authorization header",
      400,
      "INVALID_SECURITY_SCHEME",
    );
  }
  if (!validateManagedCredentialName(
    scheme.parameterName,
    scheme.location,
    scheme.bearer === true,
  )) {
    throw new ServiceError(
      "The declared credential parameter name is unsafe",
      400,
      "UNSUPPORTED_SECURITY_SCHEME",
    );
  }
  return scheme as SupportedScheme;
}

async function decryptAndRotate(
  row: typeof credentialMetadataTable.$inferSelect,
  context: Parameters<typeof decryptCredentialSecret>[1],
): Promise<string> {
  const secret = decryptCredentialSecret({
    ciphertext: row.secretCiphertext,
    iv: row.secretIv,
    authTag: row.secretAuthTag,
    keyVersion: row.keyVersion,
    keyId: row.keyId,
  }, context);
  if (isCurrentCredentialKey(row.keyId, row.keyVersion)) return secret;

  // Re-encrypt lazily, but only if this exact row and ciphertext are still present.
  // A concurrent replacement wins and is never overwritten by this maintenance update.
  const encrypted = encryptCredentialSecret(secret, context);
  await db.update(credentialMetadataTable)
    .set({
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      keyId: encrypted.keyId,
      updatedAt: new Date(),
    })
    .where(and(
      eq(credentialMetadataTable.id, row.id),
      eq(credentialMetadataTable.keyId, row.keyId),
      eq(credentialMetadataTable.keyVersion, row.keyVersion),
      eq(credentialMetadataTable.secretCiphertext, row.secretCiphertext),
    ));
  return secret;
}

export class CredentialService {
  async list(workspaceId: string, apiId: string) {
    await requireApi(workspaceId, apiId);
    await latestSpec(workspaceId, apiId);
    const rows = await db
      .select()
      .from(credentialMetadataTable)
      .where(
        and(
          eq(credentialMetadataTable.workspaceId, workspaceId),
          eq(credentialMetadataTable.apiId, apiId),
        ),
      )
      .orderBy(desc(credentialMetadataTable.updatedAt));
    return rows.map(safeCredential);
  }

  async createOrReplace(
    workspaceId: string,
    apiId: string,
    actorId: string,
    input: { schemeName: string; label: string; secret: string },
  ) {
    await requireApi(workspaceId, apiId);
    if (!input.secret || input.secret.length > 8192) {
      throw new ServiceError("Credential secret is required", 400, "INVALID_CREDENTIAL");
    }
    const spec = await latestSpec(workspaceId, apiId);
    const scheme = declaredScheme(spec, input.schemeName);
    const host = destinationHost(spec.serverUrls);
    const encrypted = encryptCredentialSecret(input.secret, {
      workspaceId,
      apiId,
      schemeName: scheme.name,
      destinationHost: host,
    });

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(credentialMetadataTable)
        .where(
          and(
            eq(credentialMetadataTable.workspaceId, workspaceId),
            eq(credentialMetadataTable.apiId, apiId),
             eq(credentialMetadataTable.schemeName, scheme.name),
          ),
        )
        .limit(1);
      const [row] = await tx
        .insert(credentialMetadataTable)
        .values({
          workspaceId,
          apiId,
          schemeName: scheme.name,
          credentialType: scheme.bearer ? "BEARER" : "API_KEY",
          location: scheme.location,
          parameterName: scheme.parameterName,
          label: input.label,
          providerName: "openapi",
          externalReference: input.label,
          destinationHost: host,
          status: "ACTIVE",
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretAuthTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          keyId: encrypted.keyId,
        })
        .onConflictDoUpdate({
          target: [
            credentialMetadataTable.workspaceId,
            credentialMetadataTable.apiId,
            credentialMetadataTable.schemeName,
          ],
          set: {
              credentialType: scheme.bearer ? "BEARER" : "API_KEY",
              location: scheme.location,
              parameterName: scheme.parameterName,
              label: input.label,
              providerName: "openapi",
              externalReference: input.label,
              status: "ACTIVE",
              secretCiphertext: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretAuthTag: encrypted.authTag,
               keyVersion: encrypted.keyVersion,
               keyId: encrypted.keyId,
               destinationHost: host,
              updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new ServiceError("Credential could not be saved", 400, "CREDENTIAL_SAVE_FAILED");
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: existing ? "credential.replaced" : "credential.configured",
        resourceType: "credential",
        resourceId: row.id,
        metadata: {
          actorId,
          apiId,
          schemeName: row.schemeName,
          type: row.credentialType,
          location: row.location,
          parameterName: row.parameterName,
          destinationHost: row.destinationHost,
          status: row.status,
        },
      });
      return safeCredential(row);
    });
  }

  async revoke(workspaceId: string, apiId: string, credentialId: string, actorId: string) {
    const [row] = await db
      .update(credentialMetadataTable)
      .set({ status: "REVOKED", updatedAt: new Date() })
      .where(
        and(
          eq(credentialMetadataTable.id, credentialId),
          eq(credentialMetadataTable.workspaceId, workspaceId),
          eq(credentialMetadataTable.apiId, apiId),
        ),
      )
      .returning();
    if (!row) throw new ServiceError("Credential not found", 404, "CREDENTIAL_NOT_FOUND");
    await db.insert(auditEventsTable).values({
      workspaceId,
      eventType: "credential.revoked",
      resourceType: "credential",
      resourceId: row.id,
      metadata: {
        actorId,
        apiId,
        schemeName: row.schemeName,
        type: row.credentialType,
        location: row.location,
        parameterName: row.parameterName,
        destinationHost: row.destinationHost,
        status: row.status,
      },
    });
    return safeCredential(row);
  }

  async secretForExecution(
    workspaceId: string,
    apiId: string,
    credentialId: string,
    expectedHost: string,
  ) {
    const [row] = await db
      .select()
      .from(credentialMetadataTable)
      .where(
        and(
          eq(credentialMetadataTable.id, credentialId),
          eq(credentialMetadataTable.workspaceId, workspaceId),
          eq(credentialMetadataTable.apiId, apiId),
          eq(credentialMetadataTable.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!row || row.destinationHost !== expectedHost.toLowerCase()) {
      throw new ServiceError("Credential is missing or invalid for this destination", 403, "CREDENTIAL_UNAVAILABLE");
    }
    return {
      secret: await decryptAndRotate(row, {
        workspaceId,
        apiId,
        schemeName: row.schemeName,
        destinationHost: row.destinationHost,
      }),
      type: row.credentialType,
      location: row.location,
      parameterName: row.parameterName,
      schemeName: row.schemeName,
    };
  }

  async resolveForExecution(input: {
    workspaceId: string;
    apiId: string;
    destinationHost: string;
    groups: readonly (readonly { scheme: string; scopes: readonly string[] }[])[];
    schemes: readonly ApiSecurityScheme[];
  }) {
    const schemeByName = new Map(input.schemes.map((scheme) => [scheme.name, scheme]));
    for (const group of input.groups) {
      const resolved: Array<{
        schemeName: string;
        type: "API_KEY" | "BEARER";
        location: "header" | "query";
        parameterName: string;
        secret: string;
      }> = [];
      let valid = true;
      for (const requirement of group) {
        const scheme = schemeByName.get(requirement.scheme);
        if (!scheme || scheme.type === "unsupported" || !scheme.location || !scheme.parameterName) {
          valid = false;
          break;
        }
        const [row] = await db
          .select()
          .from(credentialMetadataTable)
          .where(and(
            eq(credentialMetadataTable.workspaceId, input.workspaceId),
            eq(credentialMetadataTable.apiId, input.apiId),
            eq(credentialMetadataTable.schemeName, requirement.scheme),
            eq(credentialMetadataTable.destinationHost, input.destinationHost.toLowerCase()),
            eq(credentialMetadataTable.status, "ACTIVE"),
          ))
          .limit(1);
        if (!row || row.location !== scheme.location || row.parameterName !== scheme.parameterName) {
          valid = false;
          break;
        }
        try {
          resolved.push({
            schemeName: row.schemeName,
            type: row.credentialType,
            location: row.location,
            parameterName: row.parameterName,
            secret: await decryptAndRotate(row, {
              workspaceId: input.workspaceId,
              apiId: input.apiId,
              schemeName: row.schemeName,
              destinationHost: row.destinationHost,
            }),
          });
        } catch {
          valid = false;
          break;
        }
      }
      if (valid && resolved.length === group.length) return resolved;
    }
    return null;
  }

  async isConfiguredForExecution(input: {
    workspaceId: string;
    apiId: string;
    destinationHost: string;
    groups: readonly (readonly { scheme: string; scopes: readonly string[] }[])[];
    schemes: readonly ApiSecurityScheme[];
  }): Promise<boolean> {
    const schemeByName = new Map(input.schemes.map((scheme) => [scheme.name, scheme]));
    for (const group of input.groups) {
      if (!group.length) return true;
      const supported = group.every((requirement) => {
        const scheme = schemeByName.get(requirement.scheme);
        return Boolean(scheme && scheme.type !== "unsupported" && scheme.location && scheme.parameterName);
      });
      if (!supported) continue;
      const rows = await db
        .select({
          schemeName: credentialMetadataTable.schemeName,
          location: credentialMetadataTable.location,
          credentialType: credentialMetadataTable.credentialType,
          parameterName: credentialMetadataTable.parameterName,
        })
        .from(credentialMetadataTable)
        .where(and(
          eq(credentialMetadataTable.workspaceId, input.workspaceId),
          eq(credentialMetadataTable.apiId, input.apiId),
          eq(credentialMetadataTable.destinationHost, input.destinationHost.toLowerCase()),
          eq(credentialMetadataTable.status, "ACTIVE"),
        ));
      const compatible = new Map(rows.map((row) => [row.schemeName, row]));
      if (group.every((requirement) => {
        const scheme = schemeByName.get(requirement.scheme);
        const credential = compatible.get(requirement.scheme);
        if (!scheme || !credential) return false;
        const expectedType = scheme.bearer ? "BEARER" : "API_KEY";
        return credential.credentialType === expectedType &&
          credential.location === scheme.location &&
          credential.parameterName === scheme.parameterName;
      })) return true;
    }
    return false;
  }
}

export { safeCredential };