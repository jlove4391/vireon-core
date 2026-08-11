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
  /**
   * ADR 0008 Realignment A: true only when this call originates from
   * fireDueTrigger() (a scheduled trigger firing), never from a live user
   * turn. A scheduled trigger is pre-authorized background work --
   * createScheduledTrigger.ts already runs its own resolveAuthorityWithHierarchy()
   * at creation time -- fundamentally different in kind from an ad-hoc
   * conversational message, even when its synthetic content happens to
   * read the same way. This is the one flag resolveEloraRoute.ts's routing
   * policy consults to decide whether a durable_work route creates a real
   * WorkOrder (system-initiated) or gets honest acknowledgment only
   * (ordinary user turn) -- see that module's own doc comment.
   */
  isSystemInitiated?: boolean;
}

/** EloraIngressInput after normalizeIngress.ts -- no DB access, all optional fields resolved to null/false. */
export interface NormalizedEloraIngress {
  tenantId: string;
  workspaceId: string | null;
  projectId: string | null;
  threadId: string | null;
  actorId: string;
  content: string;
  sourceSurface: string | null;
  sourceCorrelationId: string | null;
  isSystemInitiated: boolean;
}

/**
 * ADR 0008 §2: the route taxonomy that replaces the old binary
 * work_order_candidate/informational split (and the declared-but-unused
 * ELORA_INTENT_TYPES superset it was drawn from). Declared as a const array
 * so src/elora/llm/types.ts can build a real Zod enum
 * (z.enum(ELORA_ROUTES)) reusing this exact vocabulary, rather than
 * redeclaring a parallel list that could drift from this one.
 *
 * memory_candidate_source from the legacy taxonomy is deliberately NOT a
 * route here -- ADR 0008 §2 treats memory candidacy as cross-cutting
 * metadata on a turn, not a destination for it. That stays out of scope
 * for Realignment A (no route currently produces a memory candidate
 * outside the still-unchanged WorkOrder-bypass paths).
 */
export const ELORA_ROUTES = [
  "converse",
  "direct_answer",
  "tool_assisted",
  "delegate",
  "durable_work",
  "consequential_action",
  "clarify",
  "setup_required",
  "capability_missing",
  "refuse",
] as const;
export type EloraRoute = (typeof ELORA_ROUTES)[number];

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

/**
 * ADR 0008 Realignment A: redesigned around `route` (§2) in place of the
 * old `intent_type` -- that field's six-value vocabulary didn't map cleanly
 * onto the new ten-way route taxonomy, so this is a genuine replacement,
 * not a parallel field bolted on next to the old one.
 *
 * task_type/summary/artifactRequest are retained from the pre-ADR-0008
 * shape and stay required/always-populated -- not because the new
 * route-based path uses them, but because they remain load-bearing for the
 * two deterministic bypass paths that still reuse the existing WorkOrder/
 * tool pipeline entirely unchanged (the explicit local-Markdown-artifact
 * pattern, and a system-trigger-initiated durable_work firing):
 * dispatchTool.ts, createWorkOrder.ts's taskType/interpretedIntent params,
 * proposeMemoryCandidates.ts, and produceDirectAnswer.ts all still read
 * them by these exact names. On the ordinary conversational route path
 * they're populated with sensible defaults ("unknown" / a truncated copy
 * of interpretedIntent) that nothing downstream reads.
 */
export interface EloraStructuredIntent {
  route: EloraRoute;
  /** The model's (or the degraded-mode classifier's) own natural-language restatement of what it understood -- ADR 0008 §2's "interpreted intent" field. */
  interpretedIntent: string;
  confidence: number;
  /** e.g. "engineering", "general" -- null when no specific domain applies. */
  taskDomain: string | null;
  /** Empty in Realignment A -- no tools are exposed to the routing model yet (Tool Stage 0/1 is Realignment C's scope). */
  requestedCapabilities: string[];
  /** Set only on route === "delegate" -- e.g. "nexora". */
  proposedDelegationTarget: string | null;
  requiresDurableWork: boolean;
  /** Empty in Realignment A, same reason as requestedCapabilities. */
  proposedToolNeeds: string[];
  externalSideEffect: boolean;
  requires_clarification: boolean;
  /** Set only when requires_clarification is true. */
  clarifyingQuestion: string | null;

  task_type: EloraTaskType;
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
  /**
   * PR 4: set only on the `informational` intent branch, which runs through
   * runInformationalCognitiveRun.ts -- the real, durable CognitiveRun id for
   * that run. Null on the work_order_candidate branch and on replayed/
   * already-processed WorkOrder results (loadAlreadyProcessedResult): no
   * cognitive run is ever created for those paths, and none should be
   * inferred for pre-existing WorkOrder flows.
   */
  cognitiveRunId: string | null;
  /**
   * PR 4: the real model_invocations id substantiating the informational
   * branch's CognitiveRun, when one exists (null only when the coordinator
   * could not substantiate completion -- see runInformationalCognitiveRun.ts
   * §4). Always null on the work_order_candidate branch.
   */
  modelInvocationId: string | null;
}
