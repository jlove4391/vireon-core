import type {
  AuthorityDecisionSubstantiatingInput,
  MemoryCandidateSubstantiatingInput,
} from "./transitionWorkOrder.js";
import type { WorkOrderStatus } from "./workOrderState.js";

// Happy-path-only fixtures for the full RECEIVED -> ... -> COMPLETED walk.
// Invalid-case and terminal-state assertions (including REFUSED /
// CAPABILITY_MISSING, which this path never visits) belong in the
// integration test itself, not here.

export const HAPPY_PATH_TASK_TYPE = "answer_question";
export const HAPPY_PATH_INTERPRETED_INTENT =
  "Prove the Phase 2 WorkOrder lifecycle engine end to end.";

export interface HappyPathTransitionFixture {
  nextStatus: WorkOrderStatus;
  reason: string;
  authorityDecision?: AuthorityDecisionSubstantiatingInput;
  memoryCandidate?: MemoryCandidateSubstantiatingInput;
}

export const HAPPY_PATH_TRANSITIONS: readonly HappyPathTransitionFixture[] = [
  { nextStatus: "INTENT_PARSED", reason: "Structured task parse completed" },
  {
    nextStatus: "AUTHORITY_CLASSIFIED",
    reason: "Authority classification completed",
    authorityDecision: {
      outcome: "act",
      requiresHumanGatekeeper: false,
      reason: "Low-risk read-only acceptance action",
      riskLevel: "low",
    },
  },
  { nextStatus: "READY_TO_ACT", reason: "Authority outcome permits immediate action" },
  { nextStatus: "EXECUTING", reason: "Run started" },
  { nextStatus: "VALIDATING", reason: "Execution complete, validating output" },
  { nextStatus: "RECEIPT_WRITTEN", reason: "Validation complete, receipt recorded" },
  {
    nextStatus: "MEMORY_CANDIDATES_CREATED",
    reason: "Deriving a memory candidate from the receipt",
    memoryCandidate: {
      candidateContent: "Phase 2 acceptance run completed the full WorkOrder lifecycle.",
      candidateType: "observation",
      confidence: 0.75,
      scope: "project",
      reasonForCreation: "Derived from WorkOrder completion during Phase 2 acceptance test",
    },
  },
  { nextStatus: "COMPLETED", reason: "WorkOrder lifecycle complete" },
];
