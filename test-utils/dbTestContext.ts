import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { withTenantTransaction } from "../src/db/withTenantTransaction.js";

export interface SeededContext {
  tenantId: string;
  userId: string;
  actorId: string;
  workspaceId: string;
  projectId: string;
  threadId: string;
  messageId: string;
}

/**
 * Seeds the prerequisite chain (tenant, user, actor, workspace, project,
 * thread, message) that the Phase 1 acceptance test builds WorkOrder /
 * AuthorityDecision / ActionReceipt / MemoryCandidate records on top of.
 */
export async function seedBaseContext(): Promise<SeededContext> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();

  // tenants is the tenant boundary itself and carries no RLS policy, so it
  // is inserted directly rather than through withTenantTransaction.
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
    tenantId,
    `phase1-test-tenant-${tenantId}`,
  ]);

  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      "INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $4)",
      [userId, tenantId, `user-${userId}@phase1.test`, "Phase 1 Test User"],
    );

    await client.query(
      `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, user_id, acting_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorId, tenantId, "human", "Phase 1 Test Actor", "requesting_user", userId, "phase1-test-harness"],
    );

    await client.query("INSERT INTO workspaces (id, tenant_id, name) VALUES ($1, $2, $3)", [
      workspaceId,
      tenantId,
      "Phase 1 Test Workspace",
    ]);

    await client.query(
      "INSERT INTO projects (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, $4)",
      [projectId, tenantId, workspaceId, "Phase 1 Test Project"],
    );

    await client.query(
      `INSERT INTO threads (id, tenant_id, workspace_id, project_id, title, status, originating_surface)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [threadId, tenantId, workspaceId, projectId, "Phase 1 Test Thread", "active", "phase1-test-harness"],
    );

    await client.query(
      `INSERT INTO messages (id, tenant_id, thread_id, actor_id, role, content, metadata, source_surface)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        messageId,
        tenantId,
        threadId,
        actorId,
        "user",
        "Seed message for the Phase 1 database spine acceptance test.",
        JSON.stringify({}),
        "phase1-test-harness",
      ],
    );
  });

  return { tenantId, userId, actorId, workspaceId, projectId, threadId, messageId };
}
