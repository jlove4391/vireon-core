import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { RetrievedMemoryRecord } from "./retrieveRelevantMemory.js";

// ADR 0008 §6/§7.4: bounded, not exhaustive -- "prefer explicit references
// and summaries over blindly loading entire thread histories." A fixed
// recent-message count plus a fixed overall character budget (matching the
// truncation-with-marker style anthropicProvider.ts's own
// MAX_USER_MESSAGE_CHARS already established) is Realignment A's scope;
// real summarization (§7.3) is a later concern this bound intentionally
// defers to rather than half-implements.
const MAX_RECENT_MESSAGES = 20;
const MAX_THREAD_CONTEXT_CHARS = 20_000;
const MAX_MEMORY_SNIPPET_CHARS = 200;

export interface AssembleThreadContextInput {
  tenantId: string;
  threadId: string;
  retrievedMemory: RetrievedMemoryRecord[];
}

interface MessageRow {
  role: string;
  content: string;
}

function boundToCharBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated, ${text.length} chars total, over the ${maxChars}-char thread-context budget]`;
}

/**
 * ADR 0008 §6: recent thread messages + retrieved durable memory + relevant
 * current CORE state + tool results + the current turn, bounded by §7.4's
 * token-budget rules. "Relevant current CORE state" and "tool results" are
 * genuine no-ops in Realignment A (no state projector exists yet -- PR 9;
 * no tools are called from the conversational loop yet -- Realignment C) --
 * not a reason to skip building the slot those future phases will fill.
 *
 * Returns undefined (not an empty string) when there is nothing to add --
 * a fresh thread with no prior messages and no retrieved memory -- so
 * callers can omit the field entirely rather than sending an empty
 * "Thread context:" preamble that adds tokens without adding information.
 */
export async function assembleThreadContext(input: AssembleThreadContextInput): Promise<string | undefined> {
  const rows = await withTenantTransaction(input.tenantId, async (client) => {
    const result = await client.query<MessageRow>(
      `SELECT role, content FROM messages
       WHERE tenant_id = $1 AND thread_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [input.tenantId, input.threadId, MAX_RECENT_MESSAGES],
    );
    return result.rows;
  });

  if (rows.length === 0 && input.retrievedMemory.length === 0) {
    return undefined;
  }

  const lines: string[] = [];

  if (rows.length > 0) {
    lines.push("Recent thread history (oldest first):");
    for (const row of [...rows].reverse()) {
      lines.push(`${row.role}: ${row.content}`);
    }
  }

  if (input.retrievedMemory.length > 0) {
    lines.push("Relevant prior memory on record:");
    for (const record of input.retrievedMemory) {
      lines.push(`- ${record.content.slice(0, MAX_MEMORY_SNIPPET_CHARS)}`);
    }
  }

  return boundToCharBudget(lines.join("\n"), MAX_THREAD_CONTEXT_CHARS);
}
