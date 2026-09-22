import { auditEventsTable, db } from "@workspace/db";
import type { AuditEventInput, AuditService } from "@workspace/security";

export class DatabaseAuditService implements AuditService {
  async record(event: AuditEventInput): Promise<void> {
    await db.insert(auditEventsTable).values({
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: { ...event.metadata },
    });
  }
}