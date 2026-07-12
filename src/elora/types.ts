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
 */
export type EloraIntentType =
  | "work_order_candidate"
  | "informational"
  | "clarification_required"
  | "setup_required"
  | "capability_missing"
  | "refusal_required";

export type EloraTaskType = "planning" | "documentation" | "analysis" | "memory" | "implementation" | "unknown";

export interface EloraStructuredIntent {
  intent_type: EloraIntentType;
  task_type: EloraTaskType;
  confidence: number;
  requires_clarification: boolean;
  summary: string;
}

export interface EloraAuthorityClassification {
  outcome: AuthorityOutcome;
  requires_human_gatekeeper: boolean;
  reason: string;
  risk_level: "low" | "medium" | "high";
  required_setup: string | null;
}

export type EloraResponseType =
  | "direct_answer"
  | "escalation_required"
  | "setup_required"
  | "capability_missing"
  | "refused"
  | "clarification_required";

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
  actionReceiptId: string | null;
  memoryCandidateIds: string[];
}
