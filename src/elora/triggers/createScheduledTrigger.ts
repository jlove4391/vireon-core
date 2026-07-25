import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { authorityDecisionSchema, type AuthorityDecision } from "../../schemas/authorityDecision.js";
import {
  scheduledTriggerSchema,
  scheduleKindSchema,
  type ScheduledTrigger,
  type ScheduleKind,
} from "../../schemas/scheduledTrigger.js";
import { buildIdempotencyKey } from "../../shared/ids.js";
import type { AuthorityOutcome } from "../../shared/runtimeTypes.js";
import { resolveAuthorityWithHierarchy } from "../resolveAuthorityWithHierarchy.js";
import { computeNextFireAt } from "./computeNextFireAt.js";
import {
  InvalidScheduledTriggerInputError,
  ScheduledTriggerActorNotFoundError,
  ScheduledTriggerPersistenceError,
} from "./errors.js";
import { writeTriggerCreatedReceipt } from "./writeTriggerCreatedReceipt.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Outcomes gated behind READY_TO_ACT-equivalent authorization in the
// ordinary WorkOrder pipeline (see ingestUserMessage.ts /
// AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS). Trigger creation reuses the
// same threshold: only these two outcomes ever persist a row.
const AUTHORIZED_OUTCOMES: ReadonlySet<AuthorityOutcome> = new Set(["act", "act_and_report"]);

export interface CreateScheduledTriggerInput {
  tenantId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /**
   * The persona this trigger fires as (the actorId 6J's firing path will
   * pass to ingestUserMessage()). Purely a target/bookkeeping field for
   * creation's own authority check -- see createdByActorId and
   * createScheduledTrigger's own doc comment for why this does NOT drive
   * the hierarchy walk.
   */
  owningActorId: string;
  /**
   * Who requested creation. This is what the authority walk actually
   * starts from -- see createScheduledTrigger's own doc comment for why.
   */
  createdByActorId: string;
  scheduleKind: ScheduleKind;
  scheduleExpression: string;
  timezone?: string | null;
  syntheticMessageContent: string;
  triggerCategory?: string | null;
}

export type CreateScheduledTriggerResult =
  | {
      status: "created";
      trigger: ScheduledTrigger;
      authorityDecision: AuthorityDecision;
      receiptId: string;
    }
  | {
      status: "blocked";
      outcome: AuthorityOutcome;
      reason: string | null;
      authorityDecision: AuthorityDecision;
    };

function validateInput(input: CreateScheduledTriggerInput): void {
  if (!UUID_PATTERN.test(input.tenantId)) throw new InvalidScheduledTriggerInputError("tenantId must be a valid UUID");
  if (!UUID_PATTERN.test(input.owningActorId)) {
    throw new InvalidScheduledTriggerInputError("owningActorId must be a valid UUID");
  }
  if (!UUID_PATTERN.test(input.createdByActorId)) {
    throw new InvalidScheduledTriggerInputError("createdByActorId must be a valid UUID");
  }
  if (input.workspaceId != null && !UUID_PATTERN.test(input.workspaceId)) {
    throw new InvalidScheduledTriggerInputError("workspaceId must be a valid UUID");
  }
  if (input.projectId != null && !UUID_PATTERN.test(input.projectId)) {
    throw new InvalidScheduledTriggerInputError("projectId must be a valid UUID");
  }
  if (scheduleKindSchema.safeParse(input.scheduleKind).success === false) {
    throw new InvalidScheduledTriggerInputError(
      `scheduleKind must be one of cron/interval/one_off, got "${input.scheduleKind}"`,
    );
  }
  if (input.scheduleExpression.trim().length === 0) {
    throw new InvalidScheduledTriggerInputError("scheduleExpression must not be empty");
  }
  if (input.syntheticMessageContent.trim().length === 0) {
    throw new InvalidScheduledTriggerInputError("syntheticMessageContent must not be empty");
  }
}

async function assertActorExists(
  client: PoolClient,
  tenantId: string,
  actorId: string,
  field: "owningActorId" | "createdByActorId",
): Promise<void> {
  const result = await client.query("SELECT id FROM actors WHERE id = $1 AND tenant_id = $2", [actorId, tenantId]);
  if (result.rows.length === 0) {
    throw new ScheduledTriggerActorNotFoundError(field, actorId);
  }
}

function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToTrigger(row: Record<string, unknown>): ScheduledTrigger {
  return scheduledTriggerSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    owning_actor_id: row.owning_actor_id,
    created_by_actor_id: row.created_by_actor_id,
    authority_decision_id: row.authority_decision_id,
    status: row.status,
    schedule_kind: row.schedule_kind,
    schedule_expression: row.schedule_expression,
    timezone: row.timezone,
    synthetic_message_content: row.synthetic_message_content,
    trigger_category: row.trigger_category,
    next_fire_at: row.next_fire_at ? toIso(row.next_fire_at as string | Date) : null,
    last_fired_at: row.last_fired_at ? toIso(row.last_fired_at as string | Date) : null,
    last_fired_work_order_id: row.last_fired_work_order_id,
    created_at: toIso(row.created_at as string | Date),
    updated_at: toIso(row.updated_at as string | Date),
  });
}

function rowToDecision(row: Record<string, unknown>): AuthorityDecision {
  return authorityDecisionSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    schema_version: row.schema_version,
    outcome: row.outcome,
    requires_human_gatekeeper: row.requires_human_gatekeeper,
    reason: row.reason,
    risk_level: row.risk_level,
    deciding_actor_id: row.deciding_actor_id,
    work_order_id: row.work_order_id,
    run_id: row.run_id,
    tool_invocation_id: row.tool_invocation_id,
    required_setup: row.required_setup,
    resolved_via_standing_rule_id: row.resolved_via_standing_rule_id,
    created_at: toIso(row.created_at as string | Date),
  });
}

/**
 * A retried identical creation request (same tenant/owning actor/schedule/
 * content -- same idempotency key) reconstructs the original result from
 * what was already persisted, instead of re-resolving authority or writing
 * anything new -- same "duplicate submission" philosophy as
 * ingestUserMessage.ts's loadAlreadyProcessedResult(), applied to a table
 * that only ever holds authorized rows (there is no "blocked" row to
 * reconstruct here -- a blocked outcome never reaches scheduled_triggers).
 */
async function loadAlreadyCreatedResult(
  client: PoolClient,
  tenantId: string,
  triggerRow: Record<string, unknown>,
): Promise<CreateScheduledTriggerResult> {
  const trigger = rowToTrigger(triggerRow);

  const decisionResult = await client.query(
    "SELECT * FROM authority_decisions WHERE id = $1 AND tenant_id = $2",
    [trigger.authority_decision_id, tenantId],
  );
  const decisionRow = decisionResult.rows[0] as Record<string, unknown> | undefined;
  if (!decisionRow) {
    throw new ScheduledTriggerPersistenceError(
      `scheduled_triggers row ${trigger.id} references authority_decision_id ${trigger.authority_decision_id}, which does not exist`,
    );
  }
  const authorityDecision = rowToDecision(decisionRow);

  const receiptIdempotencyKey = buildIdempotencyKey([tenantId, trigger.id, "receipt", "trigger_created"]);
  const receiptResult = await client.query(
    "SELECT id FROM action_receipts WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenantId, receiptIdempotencyKey],
  );
  const receiptRow = receiptResult.rows[0] as { id: string } | undefined;
  if (!receiptRow) {
    throw new ScheduledTriggerPersistenceError(
      `scheduled_triggers row ${trigger.id} has no corresponding trigger_created receipt`,
    );
  }

  return {
    status: "created",
    trigger,
    authorityDecision,
    receiptId: receiptRow.id,
  };
}

/**
 * Phase 6I, Path B (direct structured service call -- the same shape 6G
 * used for memory review/promotion): creates a scheduled trigger without
 * ever creating a WorkOrder. classifyAuthority() and
 * resolveAuthorityWithHierarchy() are called as bare functions, verified
 * (Phase B kickoff) to have zero structural dependency on a pre-existing
 * WorkOrder -- resolveAuthorityWithHierarchy only ever reads actors /
 * authority_standing_rules, never work_orders.
 *
 * Content classified is the trigger's own syntheticMessageContent, not a
 * description of "creating a trigger" -- classification asks "is what this
 * will eventually say/do, when it fires, something this persona may act on
 * without escalation," which is the meaningful question for a recurring
 * capability, not a one-off phrasing of the creation request itself.
 *
 * The hierarchy walk starts from createdByActorId, not owningActorId.
 * (Superseded reasoning, kept here as a record of the actual mistake: an
 * earlier version of this function started the walk from owningActorId,
 * reasoning by analogy to ingestUserMessage.ts's own precedent of starting
 * from the persona embodying the action. That analogy doesn't hold here --
 * ingestUserMessage.ts has exactly one live caller (a human talking to
 * Elora), so "the persona embodying the action" and "whoever is asking"
 * never diverge there. createScheduledTrigger() is the first place in this
 * codebase where creator and owner can genuinely be different actors, and
 * starting the walk from the named owner meant ANY actor that exists in
 * the tenant could name ANY other actor as owner and inherit that owner's
 * (or their superiors') standing authorizations, with zero check that the
 * creator has any actual relationship to the owner. That's a real
 * privilege-escalation path, not a stylistic choice -- a low-tier actor
 * could get a recurring capability created that fires as a high-tier
 * persona merely by naming them.)
 *
 * Anchoring to createdByActorId instead makes trigger-creation authority a
 * function of who is actually asking, consistent with every other
 * authority-classified action in this system -- the requester's own
 * standing governs the action, never a named third party's. owningActorId
 * remains a pure target/bookkeeping field (who the trigger fires as later,
 * for 6J); it is never itself an authority input at creation time. This
 * does not add any check that createdByActorId has an actual delegation or
 * reporting relationship to owningActorId (e.g. via 6D) -- naming an
 * unrelated owner is still possible, just no longer a way to borrow that
 * owner's standing rules. Whether assigning a trigger's ownership to a
 * different persona ought to require its own delegation-based check is a
 * real open question, flagged rather than silently resolved here.
 *
 * Only `act` / `act_and_report` outcomes ever persist a row: an escalated,
 * refused, setup_required, or capability_missing outcome returns
 * `status: "blocked"` with the AuthorityDecision that recorded why, and
 * writes nothing to scheduled_triggers or action_receipts.
 *
 * Idempotency key is derived from stable structural inputs (tenant, owning
 * actor, schedule, content fingerprint) per core-runtime.md 3.2 -- there is
 * no thread/message/work-order id available here to fold in, since none of
 * those exist on this path. A retried identical request is checked for
 * *before* authority is resolved at all, so a duplicate submission neither
 * re-walks the hierarchy nor writes a second, orphaned AuthorityDecision.
 */
export async function createScheduledTrigger(
  input: CreateScheduledTriggerInput,
): Promise<CreateScheduledTriggerResult> {
  validateInput(input);

  // Fail fast on a malformed schedule expression, before any DB access --
  // also the value actually inserted below on the authorized branch. 6I
  // never computed an initial next_fire_at at all (every row it created
  // was born with next_fire_at NULL, so 6J's due-query would never have
  // found it); this closes that gap using the same computeNextFireAt()
  // logic the poller uses for post-fire recomputation.
  const initialNextFireAt = computeNextFireAt({
    scheduleKind: input.scheduleKind,
    scheduleExpression: input.scheduleExpression,
    timezone: input.timezone ?? null,
    from: new Date(),
  });

  const idempotencyKey = buildIdempotencyKey([
    input.tenantId,
    input.owningActorId,
    input.scheduleKind,
    input.scheduleExpression,
    contentFingerprint(input.syntheticMessageContent),
  ]);

  const existing = await withTenantTransaction(input.tenantId, async (client) => {
    await assertActorExists(client, input.tenantId, input.owningActorId, "owningActorId");
    await assertActorExists(client, input.tenantId, input.createdByActorId, "createdByActorId");

    const result = await client.query(
      "SELECT * FROM scheduled_triggers WHERE tenant_id = $1 AND idempotency_key = $2",
      [input.tenantId, idempotencyKey],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  });

  if (existing) {
    return withTenantTransaction(input.tenantId, (client) => loadAlreadyCreatedResult(client, input.tenantId, existing));
  }

  const authority = await resolveAuthorityWithHierarchy({
    tenantId: input.tenantId,
    content: input.syntheticMessageContent,
    taskType: "unknown",
    resolvedProjectId: input.projectId ?? null,
    resolveStartingActorId: async () => input.createdByActorId,
  });

  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const authorityDecisionId = randomUUID();
    const parsedDecision = authorityDecisionSchema.parse({
      id: authorityDecisionId,
      tenant_id: input.tenantId,
      schema_version: 1,
      outcome: authority.outcome,
      requires_human_gatekeeper: authority.requires_human_gatekeeper,
      reason: authority.reason,
      risk_level: authority.risk_level,
      deciding_actor_id: input.createdByActorId,
      work_order_id: null,
      run_id: null,
      tool_invocation_id: null,
      required_setup: authority.required_setup,
      resolved_via_standing_rule_id: authority.resolvedViaStandingRuleId,
      created_at: now,
    });

    try {
      await client.query(
        `INSERT INTO authority_decisions
           (id, tenant_id, schema_version, outcome, requires_human_gatekeeper, reason,
            risk_level, deciding_actor_id, work_order_id, required_setup,
            resolved_via_standing_rule_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          parsedDecision.id,
          parsedDecision.tenant_id,
          parsedDecision.schema_version,
          parsedDecision.outcome,
          parsedDecision.requires_human_gatekeeper,
          parsedDecision.reason,
          parsedDecision.risk_level,
          parsedDecision.deciding_actor_id,
          parsedDecision.work_order_id,
          parsedDecision.required_setup,
          parsedDecision.resolved_via_standing_rule_id,
          parsedDecision.created_at,
        ],
      );
    } catch (error) {
      throw new ScheduledTriggerPersistenceError(
        `authority_decisions insert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!AUTHORIZED_OUTCOMES.has(authority.outcome)) {
      return {
        status: "blocked",
        outcome: authority.outcome,
        reason: authority.reason,
        authorityDecision: parsedDecision,
      };
    }

    const candidateId = randomUUID();
    let insertResult;
    try {
      insertResult = await client.query(
        `INSERT INTO scheduled_triggers
           (id, tenant_id, workspace_id, project_id, owning_actor_id, created_by_actor_id,
            authority_decision_id, status, schedule_kind, schedule_expression, timezone,
            synthetic_message_content, trigger_category, next_fire_at, idempotency_key, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14,$15,$15)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          candidateId,
          input.tenantId,
          input.workspaceId ?? null,
          input.projectId ?? null,
          input.owningActorId,
          input.createdByActorId,
          authorityDecisionId,
          input.scheduleKind,
          input.scheduleExpression,
          input.timezone ?? null,
          input.syntheticMessageContent,
          input.triggerCategory ?? null,
          initialNextFireAt.toISOString(),
          idempotencyKey,
          now,
        ],
      );
    } catch (error) {
      throw new ScheduledTriggerPersistenceError(
        `scheduled_triggers insert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (insertResult.rows.length === 0) {
      // Narrow race: a concurrent call with the identical idempotency key
      // won between our pre-check and this insert. The AuthorityDecision
      // row inserted just above this call is now an orphan (harmless --
      // authority_decisions carries no idempotency key by doctrine, see
      // core-runtime.md 3.2) -- reconstruct from the row that actually won,
      // exactly as the pre-check path above does.
      const raced = await client.query("SELECT * FROM scheduled_triggers WHERE tenant_id = $1 AND idempotency_key = $2", [
        input.tenantId,
        idempotencyKey,
      ]);
      return loadAlreadyCreatedResult(client, input.tenantId, raced.rows[0] as Record<string, unknown>);
    }

    const trigger = rowToTrigger(insertResult.rows[0] as Record<string, unknown>);

    const receipt = await writeTriggerCreatedReceipt(client, {
      tenantId: input.tenantId,
      trigger,
      authorityDecisionId,
      outcome: authority.outcome,
    });

    return {
      status: "created",
      trigger,
      authorityDecision: parsedDecision,
      receiptId: receipt.id,
    };
  });
}
