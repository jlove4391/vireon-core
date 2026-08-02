import type { AuthorityOutcome } from "../shared/runtimeTypes.js";
import type { WorkOrderStatus } from "../state/workOrderState.js";

/** Raw ingress payload, as received from whatever surface is calling ELORA. */
export interface EloraIngressInput {
  tenantId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Omit to start a new Thread. */
  threadId?: string | null;
  actorId: string;
  content: string;
  sourceSurface?: string | null;
  sourceCorrelationId?: string | null;
}

/** EloraIngressInput after normalizeIngress.ts -- no DB access, all optional fields resolved to null. */
export interface NormalizedEloraIngress {
  tenantId: string;
  workspaceId: string | null;
  projectId: string | null;
  threadId: string | null;
  actorId: string;
  content: string;
  sourceSurface: string | null;
  sourceCorrelationId: string | null;
}

/**
 * task_type is the concrete work category. intent_type classifies the
 * shape of the request. Per Phase 3 §5.1/§19: setup_required,
 * clarification_required, capability_missing, and refusal_required are
 * declared intent_type surface for future phases -- authority
 * classification (classifyAuthority.ts) is the sole owner of those
 * branches in Phase 3. parseIntent.ts only ever emits work_order_candidate
 * or informational.
 *
 * Declared as const arrays (not just a type union) so PR 2's
 * src/elora/llm/types.ts can build a real Zod enum
 * (z.enum(ELORA_INTENT_TYPES)) reusing this exact vocabulary for its
 * intent-interpretation operation, rather than redeclaring a parallel list
 * that could drift from this one. EloraIntentType/EloraTaskType are
 * unchanged in shape or value -- now derived from these arrays instead of
 * a hand-written union, purely a refactor.
 */
export const ELORA_INTENT_TYPES = [
  "work_order_candidate",
  "informational",
  "clarification_required",
  "setup_required",
  "capability_missing",
  "refusal_required",
] as const;
export type EloraIntentType = (typeof ELORA_INTENT_TYPES)[number];

export const ELORA_TASK_TYPES = [
  "planning",
  "documentation",
  "analysis",
  "memory",
  "implementation",
  "artifact_creation",
  "unknown",
] as const;
export type EloraTaskType = (typeof ELORA_TASK_TYPES)[number];

export interface EloraStructuredIntent {
  intent_type: EloraIntentType;
  task_type: EloraTaskType;
  confidence: number;
  requires_clarification: boolean;
  summary: string;
  /** Set only when task_type === "artifact_creation" (Phase 5 §10) -- structured extraction, not general NLU. */
  artifactRequest?: { filename: string; content: string };
}

/**
 * Phase 4 §6: a single machine-readable code, one per outcome, for stable
 * branching independent of the free-text `reason` string. Not a persisted
 * column -- it's a pure function of `outcome` (AUTHORITY_OUTCOME_TO_REASON_CODE
 * below), so it's derivable at read time from the already-persisted
 * authority_decisions.outcome column without a migration.
 */
export type AuthorityReasonCode =
  | "WITHIN_CURRENT_AUTHORITY"
  | "REPORT_REQUIRED"
  | "AUTHORIZATION_REQUIRED"
  | "CONFIGURATION_REQUIRED"
  | "CAPABILITY_UNAVAILABLE"
  | "GOVERNING_BOUNDARY";

export const AUTHORITY_OUTCOME_TO_REASON_CODE: Readonly<Record<AuthorityOutcome, AuthorityReasonCode>> = {
  act: "WITHIN_CURRENT_AUTHORITY",
  act_and_report: "REPORT_REQUIRED",
  escalate: "AUTHORIZATION_REQUIRED",
  setup_required: "CONFIGURATION_REQUIRED",
  capability_missing: "CAPABILITY_UNAVAILABLE",
  refuse: "GOVERNING_BOUNDARY",
};

export interface EloraAuthorityClassification {
  outcome: AuthorityOutcome;
  requires_human_gatekeeper: boolean;
  reason: string;
  reasonCode: AuthorityReasonCode;
  risk_level: "low" | "medium" | "high";
  required_setup: string | null;
  /**
   * Phase 6C §4.2: true only for the floor-protected escalate branch (RMT /
   * sensitive-data / irreversible-action cues). Never eligible for silent
   * resolution via a standing authorization, regardless of what rules exist
   * -- see AUTHORITY_AND_DELEGATION.md §5. Meaningless outside
   * outcome === "escalate"; every other branch sets it false.
   */
  floorProtected: boolean;
}

export type EloraResponseType =
  | "direct_answer"
  | "escalation_required"
  | "setup_required"
  | "capability_missing"
  | "refused"
  | "clarification_required"
  /** Phase 5 §8.2: a dispatched tool invocation failed (EXECUTING -> FAILED). */
  | "execution_failed";

export interface EloraIngestionResult {
  tenantId: string;
  threadId: string;
  messageId: string;
  isDuplicateMessage: boolean;
  intent: EloraStructuredIntent;
  retrievedMemoryCount: number;
  retrievedMemoryIds: string[];
  workOrderId: string | null;
  authorityDecisionId: string | null;
  authorityOutcome: AuthorityOutcome | null;
  finalWorkOrderStatus: WorkOrderStatus | null;
  transitionPath: WorkOrderStatus[];
  responseType: EloraResponseType;
  responseText: string;
  /** elora_ingestion_completed receipt id -- only set on the non-execution READY_TO_ACT happy path (Phase 3, unchanged). */
  actionReceiptId: string | null;
  /** elora_request_blocked receipt id -- only set on the four blocked branches (Phase 4 §4.2/§7). */
  blockedReceiptId: string | null;
  /** Phase 5 §8: set only when a registered tool was actually invoked through the gateway. */
  toolInvocationId: string | null;
  /** Phase 5 §11.3: set only when core.artifact.write succeeded. */
  artifactId: string | null;
  memoryCandidateIds: string[];
}
