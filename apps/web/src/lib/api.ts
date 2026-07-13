// Phase 6A §7: thin client for the one route this phase adds. No mocked
// data, no client-side reconstruction of anything the server response
// already carries -- the response is passed through as-is.

export type AuthorityOutcome = "act" | "act_and_report" | "escalate" | "setup_required" | "capability_missing" | "refuse";

export type WorkOrderStatus =
  | "RECEIVED"
  | "INTENT_PARSED"
  | "AUTHORITY_CLASSIFIED"
  | "READY_TO_ACT"
  | "AWAITING_AUTHORIZATION"
  | "SETUP_REQUIRED"
  | "CAPABILITY_MISSING"
  | "REFUSED"
  | "EXECUTING"
  | "VALIDATING"
  | "RECEIPT_WRITTEN"
  | "MEMORY_CANDIDATES_CREATED"
  | "COMPLETED"
  | "FAILED";

export type EloraResponseType =
  | "direct_answer"
  | "escalation_required"
  | "setup_required"
  | "capability_missing"
  | "refused"
  | "clarification_required"
  | "execution_failed";

export interface EloraStructuredIntent {
  intent_type: string;
  task_type: string;
  confidence: number;
  requires_clarification: boolean;
  summary: string;
  artifactRequest?: { filename: string; content: string };
}

// Mirrors src/elora/types.ts EloraIngestionResult verbatim -- do not narrow
// or transform this shape (handoff §7).
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
  blockedReceiptId: string | null;
  toolInvocationId: string | null;
  artifactId: string | null;
  memoryCandidateIds: string[];
}

export interface SendEloraMessageRequest {
  threadId?: string;
  content: string;
  clientRequestId: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

export class EloraApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EloraApiError";
  }
}

export async function sendEloraMessage(request: SendEloraMessageRequest): Promise<EloraIngestionResult> {
  const response = await fetch("/api/elora/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const body = await response.json();

  if (!response.ok) {
    const errorBody = body as ApiError;
    throw new EloraApiError(errorBody.error?.code ?? "UNKNOWN_ERROR", errorBody.error?.message ?? "Request failed");
  }

  return body as EloraIngestionResult;
}
