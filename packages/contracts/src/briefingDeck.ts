import { z } from "zod";

// Phase 6M: the stable UI-facing contract for the Operator Deck
// (GET /api/briefings/latest, POST /api/briefings/issue). This package
// exports Zod schemas and their inferred types only -- it must never
// import from src/briefing/ or any other backend-internal module. The
// enums below are OWNED by this package, deliberately duplicated from
// (not re-exported from) src/schemas/briefingIssue.ts -- confirmed
// against that file at implementation time. If an internal enum grows
// later, the backend transform function (src/http/contracts/
// briefingIssueResponse.ts) reconciles the divergence; this contract's
// enum does not have to grow in lockstep.

export const briefingLaneSchema = z.enum(["decision", "focus", "action", "blocker", "watch", "completed", "evidence"]);
export type BriefingLane = z.infer<typeof briefingLaneSchema>;

export const briefingIssueStatusSchema = z.enum(["ASSEMBLING", "ISSUED", "UPDATED", "CLOSED", "FAILED"]);
export type BriefingIssueStatus = z.infer<typeof briefingIssueStatusSchema>;

// A deliberately flattened, narrower DTO -- not a redacted copy of the
// backend's internal BriefingIssueEntry row. tenant_id, idempotency_key,
// and every raw source-reference FK (directive_id, work_order_id,
// action_receipt_id, memory_candidate_id, directive_revision_id,
// carried_from_issue_id) are excluded -- internal row identifiers with no
// current frontend use. entry_status is excluded too: the backend only
// ever returns entry_status = 'active' rows to this contract (6M's own
// scope explicitly excludes rendering 'removed' entries), so the field
// would always be the same literal value on the wire.
//
// The four *_snapshot fields ARE included -- that's the whole point of
// exposing this to the UI (6M handoff, Contract section): don't drop them.
export const BriefingEntryDTOSchema = z.object({
  id: z.string().uuid(),
  lane: briefingLaneSchema,
  rank: z.number().int().positive(),
  title: z.string(),
  detail: z.string().nullable(),
  newToIssue: z.boolean(),
  ageDaysSnapshot: z.number().int().nullable(),
  carryCountSnapshot: z.number().int().nullable(),
  deferCountSnapshot: z.number().int().nullable(),
  escalationLevelSnapshot: z.number().int().nullable(),
});
export type BriefingEntryDTO = z.infer<typeof BriefingEntryDTOSchema>;

// laneOrder/laneLabels are resolved server-side from
// src/briefing/generateProse.ts's own LANE_ORDER/LANE_HEADINGS (the same
// constants the markdown export uses) and shipped pre-resolved -- the
// frontend has no lane-label knowledge of its own, so there is only ever
// one place lane display strings are defined.
export const BriefingIssueDTOSchema = z.object({
  schemaVersion: z.literal("1"),
  id: z.string().uuid(),
  briefingType: z.string(),
  localIssueDate: z.string(),
  timezone: z.string(),
  status: briefingIssueStatusSchema,
  publishedAt: z.string().datetime().nullable(),
  firstMoveEntryId: z.string().uuid().nullable(),
  laneOrder: z.array(briefingLaneSchema),
  laneLabels: z.record(z.string(), z.string()),
  entries: z.array(BriefingEntryDTOSchema),
});
export type BriefingIssueDTO = z.infer<typeof BriefingIssueDTOSchema>;

export const GetLatestBriefingQuerySchema = z.object({
  briefingType: z.string().trim().min(1).default("daily"),
  timezone: z.string().trim().min(1, "timezone must not be empty"),
});
export type GetLatestBriefingQuery = z.infer<typeof GetLatestBriefingQuerySchema>;

// issue is null for the empty-state case (no issue exists yet for this
// tenant/type) -- a normal 200, not a 404: no issue existing yet is an
// expected first-run state, not an error.
export const LatestBriefingResponseSchema = z.object({
  schemaVersion: z.literal("1"),
  issue: BriefingIssueDTOSchema.nullable(),
});
export type LatestBriefingResponse = z.infer<typeof LatestBriefingResponseSchema>;

export const IssueBriefingRequestSchema = z.object({
  briefingType: z.string().trim().min(1),
  localIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "localIssueDate must be YYYY-MM-DD"),
  timezone: z.string().trim().min(1, "timezone must not be empty"),
});
export type IssueBriefingRequest = z.infer<typeof IssueBriefingRequestSchema>;

export const IssueBriefingResponseSchema = z.object({
  schemaVersion: z.literal("1"),
  issue: BriefingIssueDTOSchema,
  /** true when this call found an already-issued result for the same key rather than creating a new one -- issueBriefing()'s own idempotency, surfaced so the UI never needs to special-case a repeat press of "Issue Today's Briefing". */
  alreadyIssued: z.boolean(),
});
export type IssueBriefingResponse = z.infer<typeof IssueBriefingResponseSchema>;
