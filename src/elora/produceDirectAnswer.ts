import type { RetrievedMemoryRecord } from "./retrieveRelevantMemory.js";
import type { EloraStructuredIntent } from "./types.js";

/**
 * Deterministic, template-based answer -- no model calls, no pretending a
 * model produced it (Phase 3 §13). Only called on the READY_TO_ACT branch.
 */
export function produceDirectAnswer(intent: EloraStructuredIntent, retrievedMemory: RetrievedMemoryRecord[]): string {
  const lines = [
    `Understood -- I've created a WorkOrder to track this ${intent.task_type} request: "${intent.summary}".`,
  ];

  if (retrievedMemory.length > 0) {
    const snippet = retrievedMemory[0]!.content.slice(0, 160);
    lines.push(`Building on what I recall from prior context: ${snippet}`);
  }

  lines.push("This has been logged as a durable record you can inspect through the diagnostic console.");

  return lines.join(" ");
}
