import { EloraMessageResponseSchema, type EloraMessageResponse } from "@vireon/contracts";
import type { EloraIngestionResult } from "../../elora/types.js";

// Phase 6E §5: the one place allowed to import both the internal
// EloraIngestionResult type and the shared contract schema -- backend-only
// code, not part of the shared package itself. Does not touch
// ingestUserMessage() or EloraIngestionResult; adds a layer between the
// existing internal result and the HTTP response.
export function toEloraMessageResponse(result: EloraIngestionResult): EloraMessageResponse {
  const response = {
    schemaVersion: "1" as const,
    threadId: result.threadId,
    messageId: result.messageId,
    isDuplicateMessage: result.isDuplicateMessage,
    responseType: result.responseType,
    responseText: result.responseText,
    workOrderId: result.workOrderId,
    authorityOutcome: result.authorityOutcome,
    finalWorkOrderStatus: result.finalWorkOrderStatus,
    actionReceiptId: result.actionReceiptId,
    blockedReceiptId: result.blockedReceiptId,
    toolInvocationId: result.toolInvocationId,
    artifactId: result.artifactId,
    artifactFilename: result.intent.artifactRequest?.filename ?? null,
    memoryCandidateIds: result.memoryCandidateIds,
    retrievedMemoryCount: result.retrievedMemoryCount,
  };
  // Validate the backend's own output before it goes on the wire -- catches
  // a transform bug before it ever reaches the client.
  return EloraMessageResponseSchema.parse(response);
}
