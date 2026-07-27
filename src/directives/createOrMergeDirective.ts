import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import {
  directiveTypeSchema,
  type DirectiveType,
  type OperatorDirective,
  type OperatorDirectiveProvenance,
  type OperatorDirectiveRevision,
  type OperatorDirectiveTransition,
} from "../schemas/operatorDirective.js";
import { insertDirectiveProvenanceRow, type DirectiveProvenanceSource } from "./addDirectiveProvenance.js";
import { insertDirectiveRevisionRow } from "./appendDirectiveRevision.js";
import { computeDirectiveContentHash } from "./computeDirectiveContentHash.js";
import { DirectiveActorNotFoundError, DirectivePersistenceError, InvalidDirectiveInputError } from "./errors.js";
import { rowToDirective, rowToTransition } from "./rowMappers.js";
import { applyDirectiveTransition } from "./transitionDirective.js";

const CLOSED_BUT_REOPENABLE_STATES = new Set(["COMPLETED", "DISMISSED", "EXPIRED"]);

export interface CreateOrMergeDirectiveInput {
  tenantId: string;
  directiveType: DirectiveType;
  /**
   * Caller-normalized identity key. Recurring items must fold their own
   * occurrence/period into this value (e.g. "weekly-budget-review:2026-W30")
   * -- this function does not add occurrence semantics on its own.
   */
  dedupeKey: string;
  issuingActorId: string;
  owningActorId: string;
  title: string;
  body?: string | null;
  whyNow?: string | null;
  priority?: string | null;
  proposedOwnerActorId?: string | null;
  dueAt?: string | null;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  expiresAt?: string | null;
  changeReason?: string | null;
  cycleNumber?: number | null;
  provenanceSource?: DirectiveProvenanceSource;
  provenanceMetadata?: Record<string, unknown>;
}

export type CreateOrMergeDirectiveOutcome = "created" | "revised" | "carried" | "reopened" | "suppressed";

export interface CreateOrMergeDirectiveResult {
  outcome: CreateOrMergeDirectiveOutcome;
  dedupeKey: string;
  directive?: OperatorDirective;
  revision?: OperatorDirectiveRevision;
  transition?: OperatorDirectiveTransition;
  provenance?: OperatorDirectiveProvenance;
}

function validateInput(input: CreateOrMergeDirectiveInput): void {
  if (directiveTypeSchema.safeParse(input.directiveType).success === false) {
    throw new InvalidDirectiveInputError(`directiveType must be one of decision/focus/action/blocker/watch, got "${input.directiveType}"`);
  }
  if (!input.dedupeKey.trim()) {
    throw new InvalidDirectiveInputError("dedupeKey must not be empty");
  }
  if (!input.title.trim()) {
    throw new InvalidDirectiveInputError("title must not be empty");
  }
}

async function assertActorExists(client: PoolClient, tenantId: string, actorId: string, field: string): Promise<void> {
  const result = await client.query("SELECT id FROM actors WHERE id = $1 AND tenant_id = $2", [actorId, tenantId]);
  if (result.rows.length === 0) {
    throw new DirectiveActorNotFoundError(field, actorId);
  }
}

/** Mirrors due_at/window_start_at/window_end_at/expires_at from a revision onto the parent ledger row -- the one place these fields are denormalized for fast querying (title/body/priority are never denormalized; they're always read through the latest revision, per "rendered cards/prose are views"). */
async function mirrorTemporalFieldsOntoDirective(
  client: PoolClient,
  tenantId: string,
  directiveId: string,
  fields: { dueAt: string | null; windowStartAt: string | null; windowEndAt: string | null; expiresAt: string | null },
): Promise<void> {
  await client.query(
    `UPDATE operator_directives SET due_at = $1, window_start_at = $2, window_end_at = $3, expires_at = $4
     WHERE id = $5 AND tenant_id = $6`,
    [fields.dueAt, fields.windowStartAt, fields.windowEndAt, fields.expiresAt, directiveId, tenantId],
  );
}

/**
 * The dedupe/merge pipeline, per the spec's own stated order: validate
 * candidate -> normalize dedupe key -> find tenant Directive -> inspect
 * suppression -> compare material content -> create, revise, carry, or
 * reopen. Suppression gates the *entire* rest of the pipeline regardless
 * of whether an existing Directive was found -- a suppressed key neither
 * creates a new Directive nor revises/reopens an existing one (an
 * operator can still act on an already-open Directive directly via
 * transitionDirective(); suppression only blocks *this* re-detection
 * pipeline from doing anything).
 *
 * "A duplicate-detection event must not count as an operator deferral":
 * the still-live branch (PROPOSED/OPEN/IN_PROGRESS/DEFERRED) never calls
 * applyDirectiveTransition() -- no state change, no transition row, ever,
 * on a plain re-detection. Only a genuinely closed Directive
 * (COMPLETED/DISMISSED/EXPIRED) reopens automatically; SUPERSEDED is
 * terminal and re-detection against a superseded key only adds
 * provenance, without attempting a state change that would fail anyway.
 */
export async function createOrMergeDirective(input: CreateOrMergeDirectiveInput): Promise<CreateOrMergeDirectiveResult> {
  validateInput(input);
  const dedupeKey = input.dedupeKey.trim();

  return withTenantTransaction(input.tenantId, async (client) => {
    await assertActorExists(client, input.tenantId, input.issuingActorId, "issuingActorId");
    await assertActorExists(client, input.tenantId, input.owningActorId, "owningActorId");

    const existingResult = await client.query(
      "SELECT * FROM operator_directives WHERE tenant_id = $1 AND dedupe_key = $2 FOR UPDATE",
      [input.tenantId, dedupeKey],
    );
    const existingRow = existingResult.rows[0] as Record<string, unknown> | undefined;

    const suppressionResult = await client.query(
      "SELECT 1 FROM operator_directive_suppressions WHERE tenant_id = $1 AND dedupe_key = $2 AND suppressed_until > now() LIMIT 1",
      [input.tenantId, dedupeKey],
    );
    if (suppressionResult.rows.length > 0) {
      return { outcome: "suppressed", dedupeKey };
    }

    const now = new Date().toISOString();
    const temporalFields = {
      dueAt: input.dueAt ?? null,
      windowStartAt: input.windowStartAt ?? null,
      windowEndAt: input.windowEndAt ?? null,
      expiresAt: input.expiresAt ?? null,
    };

    if (!existingRow) {
      const directiveId = randomUUID();
      let directiveRow;
      try {
        const insertResult = await client.query(
          `INSERT INTO operator_directives
             (id, tenant_id, directive_type, state, dedupe_key, cycle_number, issuing_actor_id, owning_actor_id,
              first_seen_at, last_seen_at, due_at, window_start_at, window_end_at, expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,'PROPOSED',$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$8,$8)
           RETURNING *`,
          [
            directiveId,
            input.tenantId,
            input.directiveType,
            dedupeKey,
            input.cycleNumber ?? null,
            input.issuingActorId,
            input.owningActorId,
            now,
            temporalFields.dueAt,
            temporalFields.windowStartAt,
            temporalFields.windowEndAt,
            temporalFields.expiresAt,
          ],
        );
        directiveRow = insertResult.rows[0];
      } catch (error) {
        throw new DirectivePersistenceError(
          `operator_directives insert failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const revision = await insertDirectiveRevisionRow(client, {
        tenantId: input.tenantId,
        directiveId,
        title: input.title,
        body: input.body,
        whyNow: input.whyNow,
        priority: input.priority,
        proposedOwnerActorId: input.proposedOwnerActorId,
        dueAt: temporalFields.dueAt,
        windowStartAt: temporalFields.windowStartAt,
        windowEndAt: temporalFields.windowEndAt,
        expiresAt: temporalFields.expiresAt,
        changeReason: input.changeReason ?? "Initial detection",
        createdByActorId: input.issuingActorId,
      });

      const transitionId = randomUUID();
      const transitionResult = await client.query(
        `INSERT INTO operator_directive_transitions
           (id, tenant_id, directive_id, from_state, to_state, actor_id, transition_type, reason, metadata, created_at)
         VALUES ($1,$2,$3,NULL,'PROPOSED',$4,'state_change',$5,'{}'::jsonb,$6)
         RETURNING *`,
        [transitionId, input.tenantId, directiveId, input.issuingActorId, "Directive created", now],
      );

      let provenance: OperatorDirectiveProvenance | undefined;
      if (input.provenanceSource) {
        provenance = await insertDirectiveProvenanceRow(client, {
          tenantId: input.tenantId,
          directiveId,
          source: input.provenanceSource,
          metadata: input.provenanceMetadata,
        });
      }

      return {
        outcome: "created",
        dedupeKey,
        directive: rowToDirective(directiveRow as Record<string, unknown>),
        revision,
        transition: rowToTransition(transitionResult.rows[0] as Record<string, unknown>),
        provenance,
      };
    }

    // Existing Directive -- always bump last_seen_at, regardless of outcome.
    await client.query("UPDATE operator_directives SET last_seen_at = $1, updated_at = $1 WHERE id = $2 AND tenant_id = $3", [
      now,
      existingRow.id,
      input.tenantId,
    ]);

    let provenance: OperatorDirectiveProvenance | undefined;
    if (input.provenanceSource) {
      provenance = await insertDirectiveProvenanceRow(client, {
        tenantId: input.tenantId,
        directiveId: existingRow.id as string,
        source: input.provenanceSource,
        metadata: input.provenanceMetadata,
      });
    }

    const currentState = existingRow.state as string;

    if (currentState === "SUPERSEDED") {
      // Terminal, no reopen possible -- record the re-detection as
      // provenance only (already done above) and stop; attempting a
      // transition here would fail (no valid transitions out of
      // SUPERSEDED), and that's correct, not a bug to work around.
      const refreshed = await client.query("SELECT * FROM operator_directives WHERE id = $1 AND tenant_id = $2", [
        existingRow.id,
        input.tenantId,
      ]);
      return { outcome: "carried", dedupeKey, directive: rowToDirective(refreshed.rows[0] as Record<string, unknown>), provenance };
    }

    const latestRevisionResult = await client.query(
      "SELECT content_hash FROM operator_directive_revisions WHERE tenant_id = $1 AND directive_id = $2 ORDER BY revision_number DESC LIMIT 1",
      [input.tenantId, existingRow.id],
    );
    const latestHash = (latestRevisionResult.rows[0] as { content_hash: string } | undefined)?.content_hash;
    const candidateHash = computeDirectiveContentHash({
      title: input.title,
      body: input.body,
      whyNow: input.whyNow,
      priority: input.priority,
      proposedOwnerActorId: input.proposedOwnerActorId,
      dueAt: temporalFields.dueAt,
      windowStartAt: temporalFields.windowStartAt,
      windowEndAt: temporalFields.windowEndAt,
      expiresAt: temporalFields.expiresAt,
    });
    const materialChange = latestHash !== candidateHash;

    let revision: OperatorDirectiveRevision | undefined;
    if (materialChange) {
      revision = await insertDirectiveRevisionRow(client, {
        tenantId: input.tenantId,
        directiveId: existingRow.id as string,
        title: input.title,
        body: input.body,
        whyNow: input.whyNow,
        priority: input.priority,
        proposedOwnerActorId: input.proposedOwnerActorId,
        dueAt: temporalFields.dueAt,
        windowStartAt: temporalFields.windowStartAt,
        windowEndAt: temporalFields.windowEndAt,
        expiresAt: temporalFields.expiresAt,
        changeReason: input.changeReason ?? "Re-detected with updated content",
        createdByActorId: input.issuingActorId,
      });
      await mirrorTemporalFieldsOntoDirective(client, input.tenantId, existingRow.id as string, temporalFields);
    }

    if (CLOSED_BUT_REOPENABLE_STATES.has(currentState)) {
      const { directive, transition } = await applyDirectiveTransition(client, {
        tenantId: input.tenantId,
        directiveId: existingRow.id as string,
        toState: "OPEN",
        actorId: input.issuingActorId,
        reason: "Re-detected after closure -- reopened automatically",
        metadata: { reopenedAutomatically: true },
      });
      return { outcome: "reopened", dedupeKey, directive, revision, transition, provenance };
    }

    // Still live (PROPOSED/OPEN/IN_PROGRESS/DEFERRED): no state change, no
    // transition row -- a duplicate-detection event must not count as an
    // operator deferral.
    const refreshed = await client.query("SELECT * FROM operator_directives WHERE id = $1 AND tenant_id = $2", [
      existingRow.id,
      input.tenantId,
    ]);
    const refreshedDirective = rowToDirective(refreshed.rows[0] as Record<string, unknown>);

    return {
      outcome: materialChange ? "revised" : "carried",
      dedupeKey,
      directive: refreshedDirective,
      revision,
      provenance,
    };
  });
}
