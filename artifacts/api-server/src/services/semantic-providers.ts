import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
  workspacesTable,
} from "@workspace/db";
import {
  decryptSemanticProviderSecret,
  encryptSemanticProviderSecret,
  isCurrentSemanticProviderKey,
} from "./credential-crypto";
import {
  jevSemanticProviderAdapter,
  type SemanticProviderAdapter,
  type SemanticProviderTestOutcome,
} from "./semantic-provider-adapters";
import { ServiceError } from "./errors";

const PROVIDER = "jev";
const TEST_COOLDOWN_MS = 30_000;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProviderRow = typeof semanticProviderConfigsTable.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function featureEnabled(): boolean {
  return process.env.SEMANTIC_PROVIDERS_ENABLED === "true";
}

function rolloutEnabled(workspaceId: string): boolean {
  if (!featureEnabled()) return false;
  const raw = process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
  if (!raw) return false;
  const ids = raw.split(",").map((id) => id.trim());
  // A malformed operator setting denies all workspaces rather than broadening access.
  return ids.every((id) => WORKSPACE_ID_PATTERN.test(id)) &&
    ids.some((id) => id.toLowerCase() === workspaceId.toLowerCase());
}

function requireFeature(workspaceId: string): void {
  if (!featureEnabled()) {
    throw new ServiceError(
      "Semantic provider tests and readiness are disabled",
      503,
      "SEMANTIC_PROVIDERS_DISABLED",
    );
  }
  if (!rolloutEnabled(workspaceId)) {
    throw new ServiceError(
      "Connection tests and readiness are not available for this workspace",
      503,
      "SEMANTIC_PROVIDER_WORKSPACE_NOT_ALLOWED",
    );
  }
}

function notFound(): ServiceError {
  return new ServiceError("Semantic provider configuration not found", 404, "SEMANTIC_PROVIDER_NOT_FOUND");
}

async function lockWorkspaceAndRequireOwner(
  tx: DbTransaction,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const [workspace] = await tx
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(and(
      eq(workspacesTable.id, workspaceId),
      eq(workspacesTable.isLive, true),
      isNull(workspacesTable.deletedAt),
    ))
    .for("update")
    .limit(1);
  if (!workspace) {
    throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  }
  const [membership] = await tx
    .select({ role: workspaceMembershipsTable.role })
    .from(workspaceMembershipsTable)
    .where(and(
      eq(workspaceMembershipsTable.workspaceId, workspaceId),
      eq(workspaceMembershipsTable.userId, actorId),
    ))
    .for("share")
    .limit(1);
  if (!membership) {
    throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  }
  if (membership.role !== "OWNER") {
    throw new ServiceError("Workspace owner access required", 403, "OWNER_REQUIRED");
  }
}

async function assertLiveOwner(workspaceId: string, actorId: string): Promise<void> {
  const [membership] = await db
    .select({ role: workspaceMembershipsTable.role })
    .from(workspaceMembershipsTable)
    .innerJoin(
      workspacesTable,
      eq(workspacesTable.id, workspaceMembershipsTable.workspaceId),
    )
    .where(and(
      eq(workspaceMembershipsTable.workspaceId, workspaceId),
      eq(workspaceMembershipsTable.userId, actorId),
      eq(workspacesTable.isLive, true),
      isNull(workspacesTable.deletedAt),
    ))
    .limit(1);
  if (!membership) {
    throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  }
  if (membership.role !== "OWNER") {
    throw new ServiceError("Workspace owner access required", 403, "OWNER_REQUIRED");
  }
}

function credentialUsable(workspaceId: string, row?: ProviderRow): boolean {
  if (!row) return false;
  try {
    decryptSemanticProviderSecret(storedEnvelope(row), providerContext(workspaceId, row));
    return true;
  } catch {
    return false;
  }
}

async function testCooldownUntil(tx: DbTransaction, workspaceId: string): Promise<Date | null> {
  const [reservation] = await tx
    .select({ createdAt: auditEventsTable.createdAt })
    .from(auditEventsTable)
    .where(and(
      eq(auditEventsTable.workspaceId, workspaceId),
      eq(auditEventsTable.eventType, "semantic_provider.test.reserved"),
      gte(auditEventsTable.createdAt, sql`now() - (${TEST_COOLDOWN_MS} * interval '1 millisecond')`),
      sql`${auditEventsTable.metadata}->>'provider' = ${PROVIDER}`,
    ))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(1);
  return reservation ? new Date(reservation.createdAt.getTime() + TEST_COOLDOWN_MS) : null;
}

function safeMetadata(workspaceId: string, row: ProviderRow | undefined, cooldownUntil: Date | null) {
  const eligible = rolloutEnabled(workspaceId);
  const usable = credentialUsable(workspaceId, row);
  return {
    provider: PROVIDER as "jev",
    configured: Boolean(row?.secretCiphertext && row.secretIv && row.secretAuthTag),
    credentialUsable: usable,
    enabled: eligible && usable && (row?.enabled ?? false),
    rolloutEnabled: eligible,
    testCooldownUntil: cooldownUntil,
    credentialRevision: row?.credentialRevision ?? 0,
    lastTestedAt: row?.lastTestedAt ?? null,
    lastTestOutcome: (row?.lastTestOutcome ?? null) as
      | SemanticProviderTestOutcome
      | null,
    testedRevision: row?.testedRevision ?? null,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

function providerContext(workspaceId: string, row: ProviderRow) {
  return { workspaceId, provider: PROVIDER, credentialId: row.id };
}

function storedEnvelope(row: ProviderRow) {
  if (
    !row.secretCiphertext ||
    !row.secretIv ||
    !row.secretAuthTag ||
    !row.keyId ||
    row.keyVersion === null
  ) {
    throw new ServiceError("Provider key is unavailable", 503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
  }
  return {
    ciphertext: row.secretCiphertext,
    iv: row.secretIv,
    authTag: row.secretAuthTag,
    keyId: row.keyId,
    keyVersion: row.keyVersion,
  };
}

async function reserveProviderTest(
  workspaceId: string,
  actorId: string,
  row: ProviderRow,
  startedAt: Date,
  rotatedEnvelope?: ReturnType<typeof encryptSemanticProviderSecret>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
    requireFeature(workspaceId);
    const [recentReservation] = await tx
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, workspaceId),
        eq(auditEventsTable.eventType, "semantic_provider.test.reserved"),
        gte(
          auditEventsTable.createdAt,
          sql`now() - (${TEST_COOLDOWN_MS} * interval '1 millisecond')`,
        ),
        sql`${auditEventsTable.metadata}->>'provider' = ${PROVIDER}`,
      ))
      .limit(1);
    if (recentReservation) {
      throw new ServiceError(
        "Provider test cooldown is active; try again later",
        409,
        "SEMANTIC_PROVIDER_TEST_RATE_LIMITED",
      );
    }

    if (rotatedEnvelope) {
      const [rotated] = await tx
        .update(semanticProviderConfigsTable)
        .set({
          secretCiphertext: rotatedEnvelope.ciphertext,
          secretIv: rotatedEnvelope.iv,
          secretAuthTag: rotatedEnvelope.authTag,
          keyId: rotatedEnvelope.keyId,
          keyVersion: rotatedEnvelope.keyVersion,
          updatedAt: new Date(),
        })
        .where(and(
          eq(semanticProviderConfigsTable.id, row.id),
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.credentialRevision, row.credentialRevision),
          eq(semanticProviderConfigsTable.keyId, row.keyId!),
          eq(semanticProviderConfigsTable.keyVersion, row.keyVersion!),
          eq(semanticProviderConfigsTable.secretCiphertext, row.secretCiphertext!),
        ))
        .returning({ id: semanticProviderConfigsTable.id });
      if (!rotated) {
        throw new ServiceError(
          "Provider configuration changed before testing",
          409,
          "SEMANTIC_PROVIDER_REVISION_CONFLICT",
        );
      }
    }

    const [reserved] = await tx
      .update(semanticProviderConfigsTable)
      .set({ lastTestedAt: startedAt })
      .where(and(
        eq(semanticProviderConfigsTable.id, row.id),
        eq(semanticProviderConfigsTable.workspaceId, workspaceId),
        eq(semanticProviderConfigsTable.workspaceIsLive, true),
        eq(semanticProviderConfigsTable.provider, PROVIDER),
        eq(semanticProviderConfigsTable.credentialRevision, row.credentialRevision),
      ))
      .returning({ id: semanticProviderConfigsTable.id });
    if (!reserved) {
      throw new ServiceError(
        "Provider configuration changed before testing",
        409,
        "SEMANTIC_PROVIDER_REVISION_CONFLICT",
      );
    }
    await tx.insert(auditEventsTable).values({
      workspaceId,
      eventType: "semantic_provider.test.reserved",
      resourceType: "semantic_provider",
      resourceId: row.id,
      metadata: {
        actorId,
        provider: PROVIDER,
        credentialRevision: row.credentialRevision,
      },
    });
  });
}

export class SemanticProviderService {
  constructor(
    private readonly adapter: SemanticProviderAdapter = jevSemanticProviderAdapter,
    private readonly afterReservation?: () => Promise<void>,
    private readonly beforeDispatch?: () => Promise<void>,
  ) {}

  async getMetadata(workspaceId: string, actorId: string) {
    return db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
      const [row] = await tx
        .select()
        .from(semanticProviderConfigsTable)
        .where(and(
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.workspaceIsLive, true),
          eq(semanticProviderConfigsTable.provider, PROVIDER),
        ))
        .limit(1);
      return safeMetadata(workspaceId, row, await testCooldownUntil(tx, workspaceId));
    });
  }

  async saveKey(workspaceId: string, actorId: string, secret: string) {
    if (typeof secret !== "string" || secret.length === 0 || secret.length > 8192) {
      throw new ServiceError("Provider key must contain 1 to 8192 characters", 400, "INVALID_PROVIDER_KEY");
    }
    return db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);

      const [existing] = await tx
        .select()
        .from(semanticProviderConfigsTable)
        .where(and(
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.workspaceIsLive, true),
          eq(semanticProviderConfigsTable.provider, PROVIDER),
        ))
        .limit(1);
      const id = existing?.id ?? randomUUID();
      const encrypted = encryptSemanticProviderSecret(secret, {
        workspaceId,
        provider: PROVIDER,
        credentialId: id,
      });
      let row: ProviderRow | undefined;
      if (existing) {
        [row] = await tx
          .update(semanticProviderConfigsTable)
          .set({
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretAuthTag: encrypted.authTag,
            keyId: encrypted.keyId,
            keyVersion: encrypted.keyVersion,
            enabled: false,
            credentialRevision: existing.credentialRevision + 1,
            lastTestedAt: null,
            lastTestOutcome: null,
            testedRevision: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(semanticProviderConfigsTable.id, existing.id),
            eq(semanticProviderConfigsTable.workspaceId, workspaceId),
            eq(semanticProviderConfigsTable.credentialRevision, existing.credentialRevision),
          ))
          .returning();
      } else {
        [row] = await tx
          .insert(semanticProviderConfigsTable)
          .values({
            id,
            workspaceId,
            workspaceIsLive: true,
            provider: PROVIDER,
            enabled: false,
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretAuthTag: encrypted.authTag,
            keyId: encrypted.keyId,
            keyVersion: encrypted.keyVersion,
            credentialRevision: 1,
          })
          .returning();
      }
      if (!row) {
        throw new ServiceError("Provider key changed concurrently; retry the request", 409, "SEMANTIC_PROVIDER_REVISION_CONFLICT");
      }
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: existing ? "semantic_provider.key_replaced" : "semantic_provider.key_configured",
        resourceType: "semantic_provider",
        resourceId: row.id,
        metadata: {
          actorId,
          provider: PROVIDER,
          credentialRevision: row.credentialRevision,
          enabled: false,
        },
      });
      return safeMetadata(workspaceId, row, await testCooldownUntil(tx, workspaceId));
    });
  }

  async deleteKey(workspaceId: string, actorId: string) {
    return db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
      const [row] = await tx
        .delete(semanticProviderConfigsTable)
        .where(and(
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.workspaceIsLive, true),
          eq(semanticProviderConfigsTable.provider, PROVIDER),
        ))
        .returning();
      if (row) {
        await tx.insert(auditEventsTable).values({
          workspaceId,
          eventType: "semantic_provider.key_deleted",
          resourceType: "semantic_provider",
          resourceId: row.id,
          metadata: {
            actorId,
            provider: PROVIDER,
            credentialRevision: row.credentialRevision,
            enabled: row.enabled,
          },
        });
      }
      return { deleted: Boolean(row) };
    });
  }

  async refreshEncryption(workspaceId: string, actorId: string) {
    return db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
      const [existing] = await tx
        .select()
        .from(semanticProviderConfigsTable)
        .where(and(
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.workspaceIsLive, true),
          eq(semanticProviderConfigsTable.provider, PROVIDER),
        ))
        .limit(1);
      if (!existing) throw notFound();

      let secret: string;
      let current: boolean;
      try {
        secret = decryptSemanticProviderSecret(storedEnvelope(existing), providerContext(workspaceId, existing));
        current = isCurrentSemanticProviderKey(existing.keyId!, existing.keyVersion!);
      } catch {
        throw new ServiceError("Provider key cannot be decrypted; replace it to recover",
          503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
      }

      let row = existing;
      if (!current) {
        const encrypted = encryptSemanticProviderSecret(secret, providerContext(workspaceId, existing));
        const [updated] = await tx
          .update(semanticProviderConfigsTable)
          .set({
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretAuthTag: encrypted.authTag,
            keyId: encrypted.keyId,
            keyVersion: encrypted.keyVersion,
            updatedAt: new Date(),
          })
          .where(and(
            eq(semanticProviderConfigsTable.id, existing.id),
            eq(semanticProviderConfigsTable.workspaceId, workspaceId),
            eq(semanticProviderConfigsTable.credentialRevision, existing.credentialRevision),
          ))
          .returning();
        if (!updated) throw new ServiceError("Provider key changed; retry", 409, "SEMANTIC_PROVIDER_REVISION_CONFLICT");
        row = updated;
        await tx.insert(auditEventsTable).values({
          workspaceId,
          eventType: "semantic_provider.key_reencrypted",
          resourceType: "semantic_provider",
          resourceId: row.id,
          metadata: { actorId, provider: PROVIDER, credentialRevision: row.credentialRevision },
        });
      }
      return safeMetadata(workspaceId, row, await testCooldownUntil(tx, workspaceId));
    });
  }

  async setReady(workspaceId: string, actorId: string, enabled: boolean) {
    return db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
      if (enabled) requireFeature(workspaceId);
      const [existing] = await tx
        .select()
        .from(semanticProviderConfigsTable)
        .where(and(
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.workspaceIsLive, true),
          eq(semanticProviderConfigsTable.provider, PROVIDER),
        ))
        .limit(1);
      if (!existing) throw notFound();
      if (enabled && !credentialUsable(workspaceId, existing)) {
        throw new ServiceError("Provider key cannot be decrypted; replace it to recover",
          503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
      }
      if (
        enabled &&
        (!existing.secretCiphertext ||
          existing.lastTestOutcome !== "success" ||
          existing.testedRevision !== existing.credentialRevision)
      ) {
        throw new ServiceError(
          "A successful test of the current provider key is required before enabling",
          409,
          "SEMANTIC_PROVIDER_TEST_REQUIRED",
        );
      }
      const [row] = await tx
        .update(semanticProviderConfigsTable)
        .set({ enabled, updatedAt: new Date() })
        .where(and(
          eq(semanticProviderConfigsTable.id, existing.id),
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.credentialRevision, existing.credentialRevision),
        ))
        .returning();
      if (!row) {
        throw new ServiceError("Provider key changed concurrently; retry the request", 409, "SEMANTIC_PROVIDER_REVISION_CONFLICT");
      }
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: enabled ? "semantic_provider.enabled" : "semantic_provider.disabled",
        resourceType: "semantic_provider",
        resourceId: row.id,
        metadata: {
          actorId,
          provider: PROVIDER,
          credentialRevision: row.credentialRevision,
          enabled,
        },
      });
      return safeMetadata(workspaceId, row, await testCooldownUntil(tx, workspaceId));
    });
  }

  async test(workspaceId: string, actorId: string) {
    await assertLiveOwner(workspaceId, actorId);
    requireFeature(workspaceId);
    const [row] = await db
      .select()
      .from(semanticProviderConfigsTable)
      .where(and(
        eq(semanticProviderConfigsTable.workspaceId, workspaceId),
        eq(semanticProviderConfigsTable.workspaceIsLive, true),
        eq(semanticProviderConfigsTable.provider, PROVIDER),
      ))
      .limit(1);
    if (!row || !row.secretCiphertext) {
      throw new ServiceError("Configure a provider key before testing", 409, "SEMANTIC_PROVIDER_KEY_REQUIRED");
    }

    const envelope = storedEnvelope(row);
    let secret: string;
    try {
      secret = decryptSemanticProviderSecret(envelope, providerContext(workspaceId, row));
    } catch {
      throw new ServiceError("Provider key cannot be decrypted", 503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
    }

    let rotatedEnvelope: ReturnType<typeof encryptSemanticProviderSecret> | undefined;
    try {
      if (!isCurrentSemanticProviderKey(row.keyId!, row.keyVersion!)) {
        rotatedEnvelope = encryptSemanticProviderSecret(secret, providerContext(workspaceId, row));
      }
    } catch {
      throw new ServiceError("Provider key rotation is unavailable", 503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
    }

    const startedAt = new Date();
    await reserveProviderTest(workspaceId, actorId, row, startedAt, rotatedEnvelope);
    await this.afterReservation?.();

    // The reservation is already committed. Hold the workspace and membership
    // locks until dispatch is observable (response headers or network failure);
    // a revocation that commits first cannot race between a check and egress.
    const attempt = await db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
      requireFeature(workspaceId);
      const [current] = await tx
        .select({ id: semanticProviderConfigsTable.id })
        .from(semanticProviderConfigsTable)
        .where(and(
          eq(semanticProviderConfigsTable.id, row.id),
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.workspaceIsLive, true),
          eq(semanticProviderConfigsTable.credentialRevision, row.credentialRevision),
          eq(semanticProviderConfigsTable.lastTestedAt, startedAt),
        ))
        .limit(1);
      if (!current) {
        throw new ServiceError(
          "Provider configuration changed before testing",
          409,
          "SEMANTIC_PROVIDER_REVISION_CONFLICT",
        );
      }
      await this.beforeDispatch?.();
      // Operator settings are not covered by database locks. Recheck after every
      // awaited prerequisite, immediately before starting the outbound request.
      requireFeature(workspaceId);
      try {
        return await this.adapter.dispatch(secret);
      } catch {
        return { outcome: Promise.resolve("integration_error" as const) };
      }
    });
    const outcome: SemanticProviderTestOutcome = await attempt.outcome.catch(() => "integration_error");

    return db.transaction(async (tx) => {
      await lockWorkspaceAndRequireOwner(tx, workspaceId, actorId);
      requireFeature(workspaceId);
      const [updated] = await tx
        .update(semanticProviderConfigsTable)
        .set({
          lastTestedAt: startedAt,
          lastTestOutcome: outcome,
          testedRevision: row.credentialRevision,
          ...(outcome === "success" ? {} : { enabled: false }),
          updatedAt: new Date(),
        })
        .where(and(
          eq(semanticProviderConfigsTable.id, row.id),
          eq(semanticProviderConfigsTable.workspaceId, workspaceId),
          eq(semanticProviderConfigsTable.credentialRevision, row.credentialRevision),
          eq(semanticProviderConfigsTable.lastTestedAt, startedAt),
        ))
        .returning();
      if (!updated) {
        throw new ServiceError(
          "Provider key changed while its test was running; the result was discarded",
          409,
          "SEMANTIC_PROVIDER_REVISION_CONFLICT",
        );
      }
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: "semantic_provider.tested",
        resourceType: "semantic_provider",
        resourceId: updated.id,
        metadata: {
          actorId,
          provider: PROVIDER,
          credentialRevision: row.credentialRevision,
          outcome,
          enabled: updated.enabled,
        },
      });
      return {
        provider: PROVIDER as "jev",
        outcome,
        testedRevision: row.credentialRevision,
        testedAt: startedAt,
      };
    });
  }
}