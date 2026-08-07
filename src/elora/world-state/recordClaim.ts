import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { assertTenantScopedReference } from "../../db/assertTenantScopedReference.js";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { CLAIM_KINDS, CLAIM_STATUSES, claimSchema, jsonValueSchema, type Claim, type ClaimKind, type ClaimStatus, type JsonValue } from "../../schemas/claim.js";
import { claimEvidenceSchema, type ClaimEvidence } from "../../schemas/claimEvidence.js";
import { ClaimEvidenceSourceNotFoundError, ClaimNotFoundError, EntityNotFoundError, InvalidClaimInputError } from "./errors.js";

/**
 * PR 8 §8: a claim object is exactly one of another entity or a JSON
 * literal/value, never both, never neither -- enforced structurally at the
 * type level (a normal TypeScript caller cannot construct a value satisfying
 * neither branch, or both) as well as at runtime (§26, for callers that
 * bypass the type system) and in the database (chk_claims_exactly_one_object).
 * An explicitly supplied JSON `null` is a real JSON value distinct from an
 * omitted objectValue -- see jsonValueSchema's own doc comment.
 */
export type ClaimObjectInput =
  | {
      objectEntityId: string;
      objectValue?: never;
    }
  | {
      objectEntityId?: never;
      objectValue: JsonValue;
    };

/**
 * Mirrors DirectiveProvenanceSource's proven discriminated-union shape
 * (src/directives/addDirectiveProvenance.ts) -- one variant per typed
 * evidence source, making an invalid kind/id combination unrepresentable for
 * a normal caller. DB constraints (chk_claim_evidence_exactly_one_source,
 * chk_claim_evidence_source_kind_matches_reference) remain defense-in-depth.
 */
export type ClaimEvidenceSource =
  | { kind: "message"; messageId: string }
  | { kind: "work_order"; workOrderId: string }
  | { kind: "authority_decision"; authorityDecisionId: string }
  | { kind: "action_receipt"; actionReceiptId: string }
  | { kind: "directive"; directiveId: string }
  | { kind: "briefing_issue"; briefingIssueId: string }
  | { kind: "trigger"; triggerId: string }
  | { kind: "memory_record"; memoryRecordId: string };

export interface RecordClaimBaseInput {
  tenantId: string;

  subjectEntityId?: string | null;

  predicate: string;

  claimKind: ClaimKind;

  confidence?: number | null;
  sensitivity?: string | null;
  refreshAfter?: string | null;

  validFrom: string;
  validTo?: string | null;

  status?: ClaimStatus;

  supersedesClaimId?: string | null;

  evidence?: ClaimEvidenceSource[];
}

export type RecordClaimInput = RecordClaimBaseInput & ClaimObjectInput;

export interface RecordClaimResult {
  claim: Claim;
  evidence: ClaimEvidence[];
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToClaim(row: Record<string, unknown>): Claim {
  return claimSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    subject_entity_id: row.subject_entity_id,
    predicate: row.predicate,
    object_entity_id: row.object_entity_id,
    object_value: row.object_value,
    claim_kind: row.claim_kind,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    refresh_after: row.refresh_after ? toIso(row.refresh_after as string | Date) : null,
    valid_from: toIso(row.valid_from as string | Date),
    valid_to: row.valid_to ? toIso(row.valid_to as string | Date) : null,
    recorded_at: toIso(row.recorded_at as string | Date),
    status: row.status,
    supersedes_claim_id: row.supersedes_claim_id,
  });
}

function rowToClaimEvidence(row: Record<string, unknown>): ClaimEvidence {
  return claimEvidenceSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    claim_id: row.claim_id,
    source_kind: row.source_kind,
    message_id: row.message_id,
    work_order_id: row.work_order_id,
    authority_decision_id: row.authority_decision_id,
    action_receipt_id: row.action_receipt_id,
    directive_id: row.directive_id,
    briefing_issue_id: row.briefing_issue_id,
    trigger_id: row.trigger_id,
    memory_record_id: row.memory_record_id,
    created_at: toIso(row.created_at as string | Date),
  });
}

/** Extracts the object fields at runtime -- the discriminated union protects normal callers, this protects against callers that bypass the type system. */
function extractObjectFields(input: RecordClaimInput): { objectEntityId: string | undefined; objectValue: JsonValue | undefined } {
  const raw = input as unknown as { objectEntityId?: string; objectValue?: JsonValue };
  return { objectEntityId: raw.objectEntityId, objectValue: raw.objectValue };
}

interface EvidenceColumns {
  message_id: string | null;
  work_order_id: string | null;
  authority_decision_id: string | null;
  action_receipt_id: string | null;
  directive_id: string | null;
  briefing_issue_id: string | null;
  trigger_id: string | null;
  memory_record_id: string | null;
}

const EMPTY_EVIDENCE_COLUMNS: EvidenceColumns = {
  message_id: null,
  work_order_id: null,
  authority_decision_id: null,
  action_receipt_id: null,
  directive_id: null,
  briefing_issue_id: null,
  trigger_id: null,
  memory_record_id: null,
};

/** Hardcoded target table + resolved id + fully-populated column set for one evidence source. Table names are fixed literals, never derived from external input, per assertTenantScopedReference.ts's own requirement. */
function resolveEvidenceSource(source: ClaimEvidenceSource): { table: string; id: string; columns: EvidenceColumns } {
  switch (source.kind) {
    case "message":
      return { table: "messages", id: source.messageId, columns: { ...EMPTY_EVIDENCE_COLUMNS, message_id: source.messageId } };
    case "work_order":
      return { table: "work_orders", id: source.workOrderId, columns: { ...EMPTY_EVIDENCE_COLUMNS, work_order_id: source.workOrderId } };
    case "authority_decision":
      return {
        table: "authority_decisions",
        id: source.authorityDecisionId,
        columns: { ...EMPTY_EVIDENCE_COLUMNS, authority_decision_id: source.authorityDecisionId },
      };
    case "action_receipt":
      return {
        table: "action_receipts",
        id: source.actionReceiptId,
        columns: { ...EMPTY_EVIDENCE_COLUMNS, action_receipt_id: source.actionReceiptId },
      };
    case "directive":
      return { table: "operator_directives", id: source.directiveId, columns: { ...EMPTY_EVIDENCE_COLUMNS, directive_id: source.directiveId } };
    case "briefing_issue":
      return {
        table: "briefing_issues",
        id: source.briefingIssueId,
        columns: { ...EMPTY_EVIDENCE_COLUMNS, briefing_issue_id: source.briefingIssueId },
      };
    case "trigger":
      return { table: "scheduled_triggers", id: source.triggerId, columns: { ...EMPTY_EVIDENCE_COLUMNS, trigger_id: source.triggerId } };
    case "memory_record":
      return {
        table: "memory_records",
        id: source.memoryRecordId,
        columns: { ...EMPTY_EVIDENCE_COLUMNS, memory_record_id: source.memoryRecordId },
      };
    default: {
      const exhaustive: never = source;
      throw new InvalidClaimInputError(`unrecognized evidence source kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * PR 8 §26: reject contradictory/incomplete input outright rather than
 * normalizing it into something valid. The database CHECK constraints remain
 * the final guard (§21), but every one of these is worth catching before a
 * round trip to Postgres.
 */
function validateBaseInput(input: RecordClaimInput): void {
  if (!input.predicate.trim()) {
    throw new InvalidClaimInputError("predicate must not be empty");
  }
  if (!CLAIM_KINDS.includes(input.claimKind)) {
    throw new InvalidClaimInputError(`claimKind must be one of ${CLAIM_KINDS.join(", ")}`);
  }
  if (input.confidence !== undefined && input.confidence !== null) {
    if (Number.isNaN(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new InvalidClaimInputError("confidence must be between 0 and 1");
    }
  }
  if (input.sensitivity !== undefined && input.sensitivity !== null && !input.sensitivity.trim()) {
    throw new InvalidClaimInputError("sensitivity must not be blank when provided");
  }
  if (input.status !== undefined && !CLAIM_STATUSES.includes(input.status)) {
    throw new InvalidClaimInputError(`status must be one of ${CLAIM_STATUSES.join(", ")}`);
  }

  const validFromMs = Date.parse(input.validFrom);
  if (Number.isNaN(validFromMs)) {
    throw new InvalidClaimInputError("validFrom must be a valid timestamp");
  }
  if (input.validTo !== undefined && input.validTo !== null) {
    const validToMs = Date.parse(input.validTo);
    if (Number.isNaN(validToMs)) {
      throw new InvalidClaimInputError("validTo must be a valid timestamp");
    }
    if (validToMs <= validFromMs) {
      throw new InvalidClaimInputError("validTo must be strictly after validFrom");
    }
  }

  const { objectEntityId, objectValue } = extractObjectFields(input);
  const hasObjectEntityId = objectEntityId !== undefined;
  const hasObjectValue = objectValue !== undefined;
  if (hasObjectEntityId === hasObjectValue) {
    throw new InvalidClaimInputError(
      "exactly one of objectEntityId or objectValue must be provided (both present or both absent is invalid)",
    );
  }
  if (hasObjectValue && !jsonValueSchema.safeParse(objectValue).success) {
    throw new InvalidClaimInputError("objectValue must be a JSON-serializable value");
  }

  for (const source of input.evidence ?? []) {
    const { id } = resolveEvidenceSource(source);
    if (typeof id !== "string" || !id.trim()) {
      throw new InvalidClaimInputError(`evidence source ${source.kind} requires a non-empty id`);
    }
  }
}

/**
 * PR 8 §27: every caller-controlled reference to an existing row --
 * subjectEntityId, objectEntityId, supersedesClaimId, and every evidence
 * source -- is confirmed tenant-owned via the shared, domain-neutral
 * src/db/assertTenantScopedReference.ts before anything is persisted. A
 * plain FK only proves the row exists somewhere; it does not prove tenant
 * ownership, since FK constraint checks run independent of row-level
 * security (see that module's own doc comment).
 */
async function validateTenantReferences(
  client: PoolClient,
  input: RecordClaimInput,
  objectEntityId: string | undefined,
): Promise<void> {
  if (input.subjectEntityId) {
    const subjectEntityId = input.subjectEntityId;
    await assertTenantScopedReference(
      client,
      "entities",
      subjectEntityId,
      input.tenantId,
      () => new EntityNotFoundError("subjectEntityId", subjectEntityId),
    );
  }

  if (objectEntityId) {
    await assertTenantScopedReference(
      client,
      "entities",
      objectEntityId,
      input.tenantId,
      () => new EntityNotFoundError("objectEntityId", objectEntityId),
    );
  }

  if (input.supersedesClaimId) {
    const supersedesClaimId = input.supersedesClaimId;
    await assertTenantScopedReference(client, "claims", supersedesClaimId, input.tenantId, () => new ClaimNotFoundError(supersedesClaimId));
  }

  for (const source of input.evidence ?? []) {
    const { table, id } = resolveEvidenceSource(source);
    await assertTenantScopedReference(client, table, id, input.tenantId, () => new ClaimEvidenceSourceNotFoundError(source.kind, id));
  }
}

/**
 * PR 8 §25/§30: inserts one new `claims` row and its explicit evidence rows,
 * atomically. When supersedesClaimId is supplied, the prior claim is only
 * read (for tenant-ownership validation) -- never mutated. No semantic
 * validation ties the new claim's subject/predicate/object shape to the
 * superseded one; that reasoning belongs to a later projection layer (PR 9+).
 * This function proves relational linkage, not semantic correction logic.
 */
export async function recordClaim(input: RecordClaimInput): Promise<RecordClaimResult> {
  validateBaseInput(input);
  const { objectEntityId, objectValue } = extractObjectFields(input);
  const evidenceSources = input.evidence ?? [];

  return withTenantTransaction(input.tenantId, async (client) => {
    await validateTenantReferences(client, input, objectEntityId);

    const claimId = randomUUID();
    const now = new Date().toISOString();

    const claimResult = await client.query(
      `INSERT INTO claims
         (id, tenant_id, subject_entity_id, predicate, object_entity_id, object_value, claim_kind,
          confidence, sensitivity, refresh_after, valid_from, valid_to, recorded_at, status, supersedes_claim_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        claimId,
        input.tenantId,
        input.subjectEntityId ?? null,
        input.predicate,
        objectEntityId ?? null,
        objectValue !== undefined ? JSON.stringify(objectValue) : null,
        input.claimKind,
        input.confidence ?? null,
        input.sensitivity ?? null,
        input.refreshAfter ?? null,
        input.validFrom,
        input.validTo ?? null,
        now,
        input.status ?? "active",
        input.supersedesClaimId ?? null,
      ],
    );
    const claim = rowToClaim(claimResult.rows[0] as Record<string, unknown>);

    const evidence: ClaimEvidence[] = [];
    for (const source of evidenceSources) {
      const { columns } = resolveEvidenceSource(source);
      const evidenceResult = await client.query(
        `INSERT INTO claim_evidence
           (id, tenant_id, claim_id, source_kind, message_id, work_order_id, authority_decision_id,
            action_receipt_id, directive_id, briefing_issue_id, trigger_id, memory_record_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          randomUUID(),
          input.tenantId,
          claimId,
          source.kind,
          columns.message_id,
          columns.work_order_id,
          columns.authority_decision_id,
          columns.action_receipt_id,
          columns.directive_id,
          columns.briefing_issue_id,
          columns.trigger_id,
          columns.memory_record_id,
          now,
        ],
      );
      evidence.push(rowToClaimEvidence(evidenceResult.rows[0] as Record<string, unknown>));
    }

    return { claim, evidence };
  });
}
