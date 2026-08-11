import { randomUUID } from "node:crypto";
import { ELORA_PERSONA } from "@vireon/persona-config";
import type { Redis } from "ioredis";
import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import {
  acquireTriggerFiringLock,
  buildTriggerFiringLockKey,
  releaseTriggerFiringLock,
} from "../../redis/triggerLock.js";
import { buildIdempotencyKey } from "../../shared/ids.js";
import { ingestUserMessage, resolvePersonaActorId } from "../ingestUserMessage.js";
import { computeNextFireAt } from "./computeNextFireAt.js";
import { isOwnershipAssignmentAuthorized } from "./isOwnershipAssignmentAuthorized.js";
import { writeTriggerFireSkippedReceipt } from "./writeTriggerFireSkippedReceipt.js";

// core-runtime.md §15.3: a lock without a TTL can deadlock the runtime
// after a crash. This is generous relative to a single ingestUserMessage()
// call so a slow-but-healthy firing doesn't lose its own lock mid-flight,
// while still bounding how long a genuinely stuck process can wedge a
// trigger's occurrence.
const FIRING_LOCK_TTL_MS = 120_000;

/** Raw row shape as node-postgres actually returns it -- timestamptz columns come back as Date, not string. */
interface RawScheduledTriggerRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  project_id: string | null;
  owning_actor_id: string;
  created_by_actor_id: string;
  status: string;
  schedule_kind: "cron" | "interval" | "one_off";
  schedule_expression: string;
  timezone: string | null;
  synthetic_message_content: string;
  next_fire_at: Date | string | null;
  thread_id: string | null;
}

/**
 * Normalized shape used throughout this module -- next_fire_at as a
 * comparable ISO string. Comparing two separately-fetched Date instances
 * with !== is a reference comparison, always true even when they
 * represent the identical instant; every occurrence-identity check in
 * this file (the fresh-vs-due-snapshot staleness check, the lock key, the
 * sourceCorrelationId) depends on next_fire_at being a stable, comparable
 * value, so it is normalized once, immediately after every query.
 */
interface ScheduledTriggerRow extends Omit<RawScheduledTriggerRow, "next_fire_at"> {
  next_fire_at: string;
}

function normalizeTriggerRow(row: RawScheduledTriggerRow): ScheduledTriggerRow {
  if (row.next_fire_at === null) {
    throw new Error(`Scheduled trigger ${row.id} has no next_fire_at -- should never be selected as due`);
  }
  const next_fire_at = row.next_fire_at instanceof Date ? row.next_fire_at.toISOString() : row.next_fire_at;
  return { ...row, next_fire_at };
}

export type FireDueTriggerOutcome =
  | { status: "fired"; triggerId: string; workOrderId: string | null }
  | { status: "skipped"; triggerId: string; reason: "ownership_unauthorized" | "owner_not_elora" }
  | { status: "stale"; triggerId: string }
  | { status: "lock_contended"; triggerId: string };

/**
 * The "due" query surface built for exactly this purpose in 6I:
 * next_fire_at + idx_scheduled_triggers_next_fire_at (partial index,
 * WHERE status = 'active'). Plain read, no row lock -- concurrency across
 * pollers is handled per-occurrence by the Redis lock in fireDueTrigger(),
 * not here.
 */
export async function selectDueTriggers(tenantId: string): Promise<ScheduledTriggerRow[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<RawScheduledTriggerRow>(
      `SELECT id, tenant_id, workspace_id, project_id, owning_actor_id, created_by_actor_id,
              status, schedule_kind, schedule_expression, timezone, synthetic_message_content,
              next_fire_at, thread_id
       FROM scheduled_triggers
       WHERE tenant_id = $1 AND status = 'active' AND next_fire_at <= now()
       ORDER BY next_fire_at ASC`,
      [tenantId],
    );
    return result.rows.map(normalizeTriggerRow);
  });
}

/** Lazily creates and persists a trigger's own thread on its first fire; every later fire reuses it. */
async function ensureTriggerThread(client: PoolClient, tenantId: string, trigger: ScheduledTriggerRow): Promise<string> {
  if (trigger.thread_id) {
    return trigger.thread_id;
  }

  const threadId = randomUUID();
  await client.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, project_id, title, status, originating_surface)
     VALUES ($1, $2, $3, $4, $5, 'active', 'scheduled_trigger')`,
    [threadId, tenantId, trigger.workspace_id, trigger.project_id, `Scheduled trigger ${trigger.id}`],
  );

  const updateResult = await client.query(
    "UPDATE scheduled_triggers SET thread_id = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 AND thread_id IS NULL",
    [threadId, trigger.id, tenantId],
  );

  if ((updateResult.rowCount ?? 0) > 0) {
    return threadId;
  }

  // Lost a race to a concurrent firing attempt (should be rare -- the
  // Redis lock already serializes attempts on the same occurrence, but a
  // different occurrence of the same trigger firing concurrently could
  // still reach here first). Use whichever thread actually won.
  const existing = await client.query<{ thread_id: string }>(
    "SELECT thread_id FROM scheduled_triggers WHERE id = $1 AND tenant_id = $2",
    [trigger.id, tenantId],
  );
  return existing.rows[0]!.thread_id;
}

type PrepareFiringResult =
  | { proceed: false; outcome: FireDueTriggerOutcome }
  | { proceed: true; fresh: ScheduledTriggerRow; threadId: string };

/**
 * Fires exactly one due trigger occurrence, or declines to. Order of
 * checks: Redis lock (concurrency) -> fresh status re-check (the due-query
 * snapshot may be stale by the time we get here) -> Elora-only restriction
 * -> ownership-assignment guard -> fire.
 *
 * Deliberately three sequential transactions, not one: ingestUserMessage()
 * manages its own transactions internally and needs the trigger's thread
 * to already be committed and visible when it calls resolveContext() --
 * nesting it inside this function's own transaction would mean
 * resolveContext() looks for a thread that, from its own separate
 * connection's point of view, doesn't exist yet. Same "many sequential
 * withTenantTransaction calls, not one mega-transaction" shape
 * ingestUserMessage() itself already uses. Safe to split like this
 * because the Redis lock (not a DB transaction) is what actually
 * serializes concurrent attempts at the same occurrence, held for this
 * entire function's duration.
 *
 * occurrenceTimestamp is trigger.next_fire_at as read by selectDueTriggers
 * -- the scheduled moment, not wall-clock now() -- so a retried/late poll
 * cycle resolves to the exact same occurrence, and so next_fire_at
 * recomputation advances from the schedule's own last occurrence rather
 * than drifting based on when the poller happened to run.
 */
export async function fireDueTrigger(
  redis: Redis,
  tenantId: string,
  trigger: ScheduledTriggerRow,
): Promise<FireDueTriggerOutcome> {
  const occurrenceTimestamp = trigger.next_fire_at;
  const lockKey = buildTriggerFiringLockKey(tenantId, trigger.id, occurrenceTimestamp);
  const lock = await acquireTriggerFiringLock(redis, lockKey, FIRING_LOCK_TTL_MS);
  if (!lock) {
    return { status: "lock_contended", triggerId: trigger.id };
  }

  try {
    const prepared = await withTenantTransaction(tenantId, async (client): Promise<PrepareFiringResult> => {
      const freshResult = await client.query<RawScheduledTriggerRow>(
        "SELECT * FROM scheduled_triggers WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [trigger.id, tenantId],
      );
      const rawFresh = freshResult.rows[0];
      if (!rawFresh || rawFresh.status !== "active" || rawFresh.next_fire_at === null) {
        // No longer due at all -- paused/revoked/already fired past its
        // last occurrence (one_off) since the due-query ran.
        return { proceed: false, outcome: { status: "stale", triggerId: trigger.id } };
      }
      const fresh = normalizeTriggerRow(rawFresh);
      if (fresh.next_fire_at !== occurrenceTimestamp) {
        // A different attempt already advanced this trigger past this
        // exact occurrence since the due-query ran.
        return { proceed: false, outcome: { status: "stale", triggerId: trigger.id } };
      }

      const eloraActorId = await resolvePersonaActorId({ tenantId, persona: ELORA_PERSONA });
      if (fresh.owning_actor_id !== eloraActorId) {
        await writeTriggerFireSkippedReceipt(client, {
          tenantId,
          scheduledTriggerId: fresh.id,
          owningActorId: fresh.owning_actor_id,
          createdByActorId: fresh.created_by_actor_id,
          reason: "owner_not_elora",
          occurrenceTimestamp,
        });
        return { proceed: false, outcome: { status: "skipped", triggerId: fresh.id, reason: "owner_not_elora" } };
      }

      const authorized = await isOwnershipAssignmentAuthorized(
        client,
        tenantId,
        fresh.created_by_actor_id,
        fresh.owning_actor_id,
      );
      if (!authorized) {
        await writeTriggerFireSkippedReceipt(client, {
          tenantId,
          scheduledTriggerId: fresh.id,
          owningActorId: fresh.owning_actor_id,
          createdByActorId: fresh.created_by_actor_id,
          reason: "ownership_unauthorized",
          occurrenceTimestamp,
        });
        return {
          proceed: false,
          outcome: { status: "skipped", triggerId: fresh.id, reason: "ownership_unauthorized" },
        };
      }

      const threadId = await ensureTriggerThread(client, tenantId, fresh);
      return { proceed: true, fresh, threadId };
    });

    if (!prepared.proceed) {
      return prepared.outcome;
    }
    const { fresh, threadId } = prepared;

    const result = await ingestUserMessage({
      tenantId,
      workspaceId: fresh.workspace_id,
      projectId: fresh.project_id,
      threadId,
      actorId: fresh.owning_actor_id,
      content: fresh.synthetic_message_content,
      sourceSurface: "scheduled_trigger",
      sourceCorrelationId: buildIdempotencyKey([tenantId, fresh.id, occurrenceTimestamp]),
      // ADR 0008 Realignment A: a scheduled trigger firing is pre-authorized
      // background work (createScheduledTrigger.ts already ran its own
      // authority resolution at creation time), not an ad-hoc conversational
      // message -- this is the one flag resolveEloraRoute.ts's routing
      // policy consults to still create a real WorkOrder for a durable_work
      // route here, while an ordinary user's durable_work request gets
      // honest acknowledgment only.
      isSystemInitiated: true,
    });

    const nextFireAt =
      fresh.schedule_kind === "one_off"
        ? null
        : computeNextFireAt({
            scheduleKind: fresh.schedule_kind,
            scheduleExpression: fresh.schedule_expression,
            timezone: fresh.timezone,
            from: new Date(occurrenceTimestamp),
          }).toISOString();

    await withTenantTransaction(tenantId, (client) =>
      client.query(
        `UPDATE scheduled_triggers
         SET last_fired_at = now(), last_fired_work_order_id = $1, next_fire_at = $2, updated_at = now()
         WHERE id = $3 AND tenant_id = $4`,
        [result.workOrderId, nextFireAt, fresh.id, tenantId],
      ),
    );

    return { status: "fired", triggerId: fresh.id, workOrderId: result.workOrderId };
  } finally {
    await releaseTriggerFiringLock(redis, lock);
  }
}

/** One poll pass for a single tenant: find what's due, attempt to fire each. */
export async function pollTenantOnce(redis: Redis, tenantId: string): Promise<FireDueTriggerOutcome[]> {
  const due = await selectDueTriggers(tenantId);
  const outcomes: FireDueTriggerOutcome[] = [];
  for (const trigger of due) {
    outcomes.push(await fireDueTrigger(redis, tenantId, trigger));
  }
  return outcomes;
}

/**
 * One poll pass across every tenant. tenants carries no RLS (it is the
 * tenant boundary itself, per migration 0001's own comment) -- this is
 * the one place in the runtime that legitimately needs to discover
 * tenants before it has a tenant context, rather than a bypass of RLS on
 * any tenant-scoped table.
 */
export async function pollAllTenantsOnce(redis: Redis): Promise<FireDueTriggerOutcome[]> {
  const tenantsResult = await pool.query<{ id: string }>("SELECT id FROM tenants");
  const outcomes: FireDueTriggerOutcome[] = [];
  for (const row of tenantsResult.rows) {
    outcomes.push(...(await pollTenantOnce(redis, row.id)));
  }
  return outcomes;
}
