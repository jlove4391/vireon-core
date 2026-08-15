import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { EloraMessagePersistenceError, EloraThreadPersistenceError } from "./errors.js";
import type { ResolvedEloraContext } from "./resolveContext.js";

export interface PersistMessageInput {
  context: ResolvedEloraContext;
  content: string;
  sourceSurface: string | null;
  sourceCorrelationId: string | null;
}

export interface PersistedMessage {
  threadId: string;
  messageId: string;
  /** Canonical content -- differs from input.content only on a duplicate-correlation match (see §9). */
  content: string;
  isDuplicate: boolean;
}

/**
 * Creates or continues a Thread, then persists the Message -- one
 * tenant-scoped transaction, committed before any WorkOrder work begins
 * (core-runtime.md 3.3/3.4; ELORA.md 9.1). Duplicate submission handling:
 * on a (tenant_id, thread_id, source_correlation_id) match against an
 * existing Message, returns the canonical original Message's content
 * rather than the incoming duplicate payload, so every downstream step
 * (parseIntent, classifyAuthority, WorkOrder idempotency fingerprinting)
 * operates on identical input regardless of which submission produced it.
 */
export async function persistMessage(input: PersistMessageInput): Promise<PersistedMessage> {
  return withTenantTransaction(input.context.tenantId, async (client) => {
    let threadId = input.context.threadId;

    if (!threadId) {
      threadId = randomUUID();
      try {
        await client.query(
          `INSERT INTO threads (id, tenant_id, workspace_id, project_id, title, status, originating_surface)
           VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
          [
            threadId,
            input.context.tenantId,
            input.context.workspaceId,
            input.context.projectId,
            input.content.slice(0, 120),
            input.sourceSurface,
          ],
        );
      } catch (error) {
        throw new EloraThreadPersistenceError(error instanceof Error ? error.message : String(error));
      }
    }

    if (input.sourceCorrelationId) {
      const existing = await client.query(
        `SELECT id, content FROM messages
         WHERE tenant_id = $1 AND thread_id = $2 AND source_correlation_id = $3
         ORDER BY created_at ASC
         LIMIT 1`,
        [input.context.tenantId, threadId, input.sourceCorrelationId],
      );
      const existingRow = existing.rows[0] as { id: string; content: string } | undefined;
      if (existingRow) {
        return { threadId, messageId: existingRow.id, content: existingRow.content, isDuplicate: true };
      }
    }

    const messageId = randomUUID();
    try {
      await client.query(
        `INSERT INTO messages (id, tenant_id, thread_id, actor_id, role, content, metadata, source_surface, source_correlation_id)
         VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8)`,
        [
          messageId,
          input.context.tenantId,
          threadId,
          input.context.actorId,
          input.content,
          JSON.stringify({}),
          input.sourceSurface,
          input.sourceCorrelationId,
        ],
      );
    } catch (error) {
      throw new EloraMessagePersistenceError(error instanceof Error ? error.message : String(error));
    }

    return { threadId, messageId, content: input.content, isDuplicate: false };
  });
}

/**
 * ADR 0008 §6: thread-context assembly (assembleThreadContext.ts) needs
 * ELORA's own prior replies, not just the human's turns -- "Why did you
 * recommend Postgres?" cannot resolve "you recommended Postgres" from
 * user-role messages alone. Nothing before Realignment A ever persisted an
 * assistant-role message; this closes that gap for the new conversational
 * route path specifically. Deliberately not called from the WorkOrder-bypass
 * pipeline (the artifact-creation pattern, or a system-trigger firing) --
 * that pipeline's behavior is unchanged by this ADR, and its own responses
 * are already durable via receipts.
 */
export async function persistAssistantReply(input: {
  tenantId: string;
  threadId: string;
  actorId: string;
  content: string;
}): Promise<void> {
  await withTenantTransaction(input.tenantId, async (client) => {
    try {
      await client.query(
        `INSERT INTO messages (id, tenant_id, thread_id, actor_id, role, content, metadata, source_surface, source_correlation_id)
         VALUES ($1, $2, $3, $4, 'assistant', $5, $6, NULL, NULL)`,
        [randomUUID(), input.tenantId, input.threadId, input.actorId, input.content, JSON.stringify({})],
      );
    } catch (error) {
      throw new EloraMessagePersistenceError(error instanceof Error ? error.message : String(error));
    }
  });
}
