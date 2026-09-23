import { and, eq } from "drizzle-orm";
import { connectorActorsTable, db } from "@workspace/db";

// Snapshot the label at the time of the event. Do not derive historical identity
// from an actor row that may later be renamed or removed.
export async function connectorAttribution(workspaceId: string, memberId: string) {
  const [actor] = await db.select({ name: connectorActorsTable.name })
    .from(connectorActorsTable)
    .where(and(
      eq(connectorActorsTable.workspaceId, workspaceId),
      eq(connectorActorsTable.memberId, memberId),
    ))
    .limit(1);
  return {
    actorId: memberId,
    actorType: "CONNECTOR",
    actorLabel: actor ? `Connector: ${actor.name}` : "Connector",
  };
}