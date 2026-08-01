import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { assertTenantScopedReference } from "../db/assertTenantScopedReference.js";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { BriefingIssue, BriefingIssueEntry } from "../schemas/briefingIssue.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import {
  ensureWorkspaceRoot,
  loadWorkspaceConfig,
  removeWorkspaceFileQuietly,
  resolveContainedPath,
  resolveWorkspaceRoot,
  writeWorkspaceFile,
} from "../tools/workspace.js";
import { collectCandidates, type CandidateEntryDraft } from "./collectCandidates.js";
import { BriefingPersistenceError, BriefingReferenceNotFoundError, InvalidBriefingInputError } from "./errors.js";
import { generateProse, type RenderableEntry } from "./generateProse.js";
import { rowToBriefingIssue, rowToBriefingIssueEntry } from "./rowMappers.js";
import { rankWithinLane, selectFirstMove } from "./selectFirstMove.js";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface IssueBriefingInput {
  tenantId: string;
  briefingType: string;
  localIssueDate: string;
  timezone: string;
  /** Caller-supplied, no tenant-confirmed object to derive it from at this entry point -- see assertTenantScopedReference() call below (Phase B go-ahead, Required Verification 1). */
  issuedByActorId: string;
  sourceMessageId?: string | null;
  sourceWorkOrderId?: string | null;
  /** Test seam -- defaults to the real wall clock. */
  now?: Date;
}

export interface IssueBriefingResult {
  issue: BriefingIssue;
  entries: BriefingIssueEntry[];
  /** true when an already-committed row for this idempotency key was found and returned as-is -- no new assembly work performed (acceptance criterion 9: restart does not duplicate). */
  alreadyIssued: boolean;
}

function validateInput(input: IssueBriefingInput): void {
  if (!input.briefingType.trim()) {
    throw new InvalidBriefingInputError("briefingType must not be empty");
  }
  if (!LOCAL_DATE_PATTERN.test(input.localIssueDate)) {
    throw new InvalidBriefingInputError(`localIssueDate must be YYYY-MM-DD, got "${input.localIssueDate}"`);
  }
  if (!input.timezone.trim()) {
    throw new InvalidBriefingInputError("timezone must not be empty");
  }
}

/**
 * "derived-not-trusted" (Phase B go-ahead) -- looks the referenced row up
 * tenant-scoped first and returns the id from the *locked-up* row, never
 * the raw caller-supplied value directly, mirroring
 * transitionWorkOrder.ts's lockWorkOrder() pattern. Returns null when the
 * optional input itself was null (nothing to resolve).
 */
async function resolveOptionalTenantScopedId(
  client: PoolClient,
  table: "messages" | "work_orders",
  tenantId: string,
  id: string | null | undefined,
  field: string,
): Promise<string | null> {
  if (id == null) return null;
  const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  const row = result.rows[0] as { id: string } | undefined;
  if (!row) {
    throw new BriefingReferenceNotFoundError(field, id);
  }
  return row.id;
}

function sourceColumn(source: CandidateEntryDraft["source"]): { column: "directive_id" | "work_order_id" | "action_receipt_id" | "memory_candidate_id"; value: string } {
  switch (source.kind) {
    case "directive":
      return { column: "directive_id", value: source.directiveId };
    case "work_order":
      return { column: "work_order_id", value: source.workOrderId };
    case "action_receipt":
      return { column: "action_receipt_id", value: source.actionReceiptId };
    case "memory_candidate":
      return { column: "memory_candidate_id", value: source.memoryCandidateId };
  }
}

/**
 * Was this exact candidate present as an active entry in a *prior*
 * issue of the same tenant? `column` is always one of four fixed,
 * hardcoded literals from sourceColumn() above -- never derived from
 * caller input -- since it's interpolated directly into the query, same
 * requirement as assertTenantScopedReference()'s own `table` parameter.
 */
async function findCarriedFromIssueId(
  client: PoolClient,
  tenantId: string,
  currentIssueId: string,
  source: CandidateEntryDraft["source"],
): Promise<string | null> {
  const { column, value } = sourceColumn(source);
  const result = await client.query(
    `SELECT bi.id AS id
     FROM briefing_issue_entries bie
     JOIN briefing_issues bi ON bi.id = bie.briefing_issue_id AND bi.tenant_id = bie.tenant_id
     WHERE bie.tenant_id = $1 AND bie.${column} = $2 AND bie.entry_status = 'active' AND bi.id != $3
     ORDER BY bi.published_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, value, currentIssueId],
  );
  return (result.rows[0] as { id: string } | undefined)?.id ?? null;
}

async function fetchEntries(client: PoolClient, tenantId: string, briefingIssueId: string): Promise<BriefingIssueEntry[]> {
  const result = await client.query(
    `SELECT * FROM briefing_issue_entries WHERE tenant_id = $1 AND briefing_issue_id = $2 ORDER BY lane, rank`,
    [tenantId, briefingIssueId],
  );
  return (result.rows as Record<string, unknown>[]).map(rowToBriefingIssueEntry);
}

/**
 * Public entry point -- one of this domain's core services. Opens its
 * own transaction; the entire assembly (candidate collection, first-move
 * selection, prose generation, entries + prose-artifact + issue-row
 * writes) runs as ONE atomic transaction.
 *
 * Restart/idempotency (acceptance criterion 9, Phase B go-ahead): the
 * issue row is inserted with `INSERT ... ON CONFLICT (tenant_id,
 * idempotency_key) DO NOTHING` *before* any of the expensive assembly
 * work runs. A concurrent racing call blocks on Postgres's own unique-
 * index serialization (the same mechanism 6K's Finding 2 fix relies on
 * and sabotage-proved) until the winner's transaction commits, then sees
 * the conflict and re-fetches the winner's fully-committed result --
 * never a half-assembled row. A crashed/failed attempt rolls back its
 * entire transaction, including the issue-row insert itself, so a
 * subsequent call sees no conflict and reassembles cleanly from scratch
 * -- there is never more than one *committed* row per idempotency key,
 * which is what "restart does not duplicate" actually requires. This is
 * why ASSEMBLING/FAILED are schema-complete (migrations/0012) but not
 * durably reachable from this function -- see the migration's own doc
 * comment.
 */
export async function issueBriefing(input: IssueBriefingInput): Promise<IssueBriefingResult> {
  validateInput(input);
  const now = input.now ?? new Date();

  return withTenantTransaction(input.tenantId, async (client) => {
    await assertTenantScopedReference(
      client,
      "actors",
      input.issuedByActorId,
      input.tenantId,
      () => new BriefingReferenceNotFoundError("issuedByActorId", input.issuedByActorId),
    );
    const sourceMessageId = await resolveOptionalTenantScopedId(client, "messages", input.tenantId, input.sourceMessageId, "sourceMessageId");
    const sourceWorkOrderId = await resolveOptionalTenantScopedId(
      client,
      "work_orders",
      input.tenantId,
      input.sourceWorkOrderId,
      "sourceWorkOrderId",
    );

    const idempotencyKey = buildIdempotencyKey([input.tenantId, input.briefingType, input.localIssueDate, input.timezone]);
    const candidateIssueId = randomUUID();
    const nowIso = now.toISOString();

    let insertResult;
    try {
      insertResult = await client.query(
        `INSERT INTO briefing_issues
           (id, tenant_id, briefing_type, local_issue_date, timezone, status, issued_by_actor_id,
            source_message_id, source_work_order_id, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,'ASSEMBLING',$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          candidateIssueId,
          input.tenantId,
          input.briefingType,
          input.localIssueDate,
          input.timezone,
          input.issuedByActorId,
          sourceMessageId,
          sourceWorkOrderId,
          idempotencyKey,
          nowIso,
        ],
      );
    } catch (error) {
      throw new BriefingPersistenceError(`briefing_issues insert failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (insertResult.rows.length === 0) {
      // Lost the race, or this is a plain duplicate call for an
      // already-issued key -- either way, return the winner's committed
      // result rather than redo any work.
      const existingResult = await client.query("SELECT * FROM briefing_issues WHERE tenant_id = $1 AND idempotency_key = $2", [
        input.tenantId,
        idempotencyKey,
      ]);
      const existingRow = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new BriefingPersistenceError(`briefing_issues insert for idempotency_key "${idempotencyKey}" conflicted but no row was found on retry`);
      }
      const issue = rowToBriefingIssue(existingRow);
      const entries = await fetchEntries(client, input.tenantId, issue.id);
      return { issue, entries, alreadyIssued: true };
    }

    // Won the race (or no conflict existed): do the full assembly.
    const { drafts, sinceTimestamp } = await collectCandidates(client, input.tenantId, input.briefingType, now);
    const rankByDraft = rankWithinLane(drafts);

    const carriedFromIssueIdByDraft = new Map<CandidateEntryDraft, string | null>();
    for (const draft of drafts) {
      carriedFromIssueIdByDraft.set(draft, await findCarriedFromIssueId(client, input.tenantId, candidateIssueId, draft.source));
    }

    const entries: BriefingIssueEntry[] = [];
    const renderables: RenderableEntry[] = [];
    for (const draft of drafts) {
      const entryId = randomUUID();
      const carriedFromIssueId = carriedFromIssueIdByDraft.get(draft) ?? null;
      const rank = rankByDraft.get(draft) ?? 1;

      const values = {
        directive_id: draft.source.kind === "directive" ? draft.source.directiveId : null,
        directive_revision_id: draft.source.kind === "directive" ? draft.source.directiveRevisionId : null,
        work_order_id: draft.source.kind === "work_order" ? draft.source.workOrderId : null,
        action_receipt_id: draft.source.kind === "action_receipt" ? draft.source.actionReceiptId : null,
        memory_candidate_id: draft.source.kind === "memory_candidate" ? draft.source.memoryCandidateId : null,
      };

      const insertEntry = await client.query(
        `INSERT INTO briefing_issue_entries
           (id, tenant_id, briefing_issue_id, directive_id, directive_revision_id, work_order_id, action_receipt_id,
            memory_candidate_id, lane, rank, entry_status, new_to_issue, carried_from_issue_id,
            age_days_snapshot, carry_count_snapshot, defer_count_snapshot, escalation_level_snapshot,
            inclusion_reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          entryId,
          input.tenantId,
          candidateIssueId,
          values.directive_id,
          values.directive_revision_id,
          values.work_order_id,
          values.action_receipt_id,
          values.memory_candidate_id,
          draft.lane,
          rank,
          carriedFromIssueId === null,
          carriedFromIssueId,
          draft.ageDaysSnapshot,
          draft.carryCountSnapshot,
          draft.deferCountSnapshot,
          draft.escalationLevelSnapshot,
          draft.inclusionReason,
          nowIso,
        ],
      );
      const entry = rowToBriefingIssueEntry(insertEntry.rows[0] as Record<string, unknown>);
      entries.push(entry);
      renderables.push({ entry, title: draft.displayTitle, detail: draft.displayDetail });
    }

    const firstMoveDraft = selectFirstMove(drafts);
    const firstMoveDirectiveId = firstMoveDraft && firstMoveDraft.source.kind === "directive" ? firstMoveDraft.source.directiveId : null;
    const firstMoveRenderable = firstMoveDirectiveId ? (renderables.find((r) => r.entry.directive_id === firstMoveDirectiveId) ?? null) : null;

    const prose = generateProse(
      { briefingType: input.briefingType, localIssueDate: input.localIssueDate, timezone: input.timezone, sinceTimestamp },
      renderables,
      firstMoveRenderable,
    );

    const proseArtifactId = await insertProseArtifact(client, input.tenantId, candidateIssueId, input.briefingType, input.localIssueDate, prose, nowIso);

    const updateResult = await client.query(
      `UPDATE briefing_issues
       SET status = 'ISSUED', first_move_directive_id = $1, prose_artifact_id = $2, generated_at = $3, published_at = $3
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [firstMoveDirectiveId, proseArtifactId, nowIso, candidateIssueId, input.tenantId],
    );

    return { issue: rowToBriefingIssue(updateResult.rows[0] as Record<string, unknown>), entries, alreadyIssued: false };
  });
}

/**
 * Direct insert into `artifacts`, bypassing the tool gateway (Phase B
 * go-ahead) -- a briefing issuance has no natural WorkOrder to route
 * core.artifact.write through, same precedent as 6I's scheduled_triggers
 * / 6G's memory review (direct structured service call, no WorkOrder).
 * Reuses the same bounded-workspace file-write primitives
 * artifactWrite.ts itself uses, at a deterministic path (so a retry after
 * a mid-assembly crash overwrites cleanly rather than colliding) --
 * `work_order_id` on the artifacts row is left NULL, which the schema
 * already allows (migrations/0001, never made NOT NULL by 0003).
 */
async function insertProseArtifact(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  briefingType: string,
  localIssueDate: string,
  prose: string,
  nowIso: string,
): Promise<string> {
  const config = loadWorkspaceConfig();
  const root = resolveWorkspaceRoot(config, tenantId, null);
  await ensureWorkspaceRoot(root);

  const relativePath = `briefings/${briefingType}/${localIssueDate}.md`;
  const writeResult = await writeWorkspaceFile(config, root, relativePath, prose, { allowOverwrite: true });

  const artifactId = randomUUID();
  const idempotencyKey = buildIdempotencyKey([tenantId, issueId, "artifact", "briefing_prose"]);

  try {
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, work_order_id, artifact_type, storage_reference, content_pointer, mime_type, byte_count,
          content_hash, idempotency_key, created_at)
       VALUES ($1,$2,NULL,'briefing_prose',$3,NULL,'text/markdown',$4,$5,$6,$7)`,
      [artifactId, tenantId, writeResult.relativePath, writeResult.byteCount, writeResult.contentHash, idempotencyKey, nowIso],
    );
  } catch (error) {
    await removeWorkspaceFileQuietly(resolveContainedPath(root, relativePath));
    throw new BriefingPersistenceError(`artifacts insert failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return artifactId;
}
