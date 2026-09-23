import { promises as dns } from "node:dns";
import { and, eq } from "drizzle-orm";
import {
  apiOperationsTable,
  auditEventsTable,
  credentialMetadataTable,
  db,
  operationPoliciesTable,
} from "@workspace/db";
import {
  HttpsOutboundRequestBroker,
  type AuditEventInput,
  type AuditService,
  type CredentialProvider,
  type PolicyDecision,
  type PolicyEngine,
  type OutboundRequestBroker,
} from "@workspace/security";
import { CredentialService } from "./credentials";
import { connectorAttribution } from "./connector-attribution";

export class DatabaseAuditService implements AuditService {
  async record(event: AuditEventInput): Promise<void> {
    const attribution: Record<string, string> = {};
    if (event.actorId) {
      if (event.actorId.startsWith("svc:")) {
        Object.assign(attribution, await connectorAttribution(event.workspaceId, event.actorId));
      } else {
        attribution.actorId = event.actorId;
        attribution.actorType = "HUMAN";
      }
    }
    await db.insert(auditEventsTable).values({
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: {
        ...event.metadata,
        ...attribution,
      },
    });
  }
}

export class DatabaseCredentialProvider implements CredentialProvider {
  private readonly service = new CredentialService();
  async inspect(referenceId: string) {
    const [row] = await db
      .select()
      .from(credentialMetadataTable)
      .where(eq(credentialMetadataTable.id, referenceId))
      .limit(1);
    return row
      ? {
          id: row.id,
          workspaceId: row.workspaceId,
          apiSourceId: row.apiId,
          destinationHost: row.destinationHost,
          status: row.status,
        }
      : null;
  }

  async resolve(input: Parameters<CredentialProvider["resolve"]>[0]) {
    return this.service.resolveForExecution({
      workspaceId: input.workspaceId,
      apiId: input.apiSourceId,
      destinationHost: input.destinationHost,
      groups: input.groups,
      schemes: input.schemes,
    });
  }

  async isConfigured(input: Parameters<CredentialProvider["isConfigured"]>[0]) {
    return this.service.isConfiguredForExecution({
      workspaceId: input.workspaceId,
      apiId: input.apiSourceId,
      destinationHost: input.destinationHost,
      groups: input.groups,
      schemes: input.schemes,
    });
  }
}

export class DatabasePolicyEngine implements PolicyEngine {
  async evaluate(context: Parameters<PolicyEngine["evaluate"]>[0]): Promise<PolicyDecision> {
    const [row] = await db
      .select({
        enabled: apiOperationsTable.enabled,
        decision: operationPoliciesTable.decision,
        approved: operationPoliciesTable.executionApproved,
      })
      .from(apiOperationsTable)
      .innerJoin(
        operationPoliciesTable,
        and(
          eq(operationPoliciesTable.workspaceId, apiOperationsTable.workspaceId),
          eq(operationPoliciesTable.operationId, apiOperationsTable.id),
        ),
      )
      .where(
        and(
          eq(apiOperationsTable.workspaceId, context.workspaceId),
          eq(apiOperationsTable.apiId, context.apiSourceId),
          eq(apiOperationsTable.id, context.operationRecordId),
        ),
      )
      .limit(1);
    return row?.enabled && row.approved ? row.decision : "DENY";
  }
}

const auditService = new DatabaseAuditService();
const credentialProvider = new DatabaseCredentialProvider();
const policyEngine = new DatabasePolicyEngine();

export const securityServices: {
  auditService: AuditService;
  credentialProvider: CredentialProvider;
  policyEngine: PolicyEngine;
  outboundRequestBroker: OutboundRequestBroker;
} = {
  auditService,
  credentialProvider,
  policyEngine,
  outboundRequestBroker: new HttpsOutboundRequestBroker(
    policyEngine,
    credentialProvider,
    auditService,
    {
      async resolve(hostname: string) {
        const rows = await dns.lookup(hostname, { all: true, verbatim: true });
        return rows.map((row) => row.address);
      },
    },
  ),
};