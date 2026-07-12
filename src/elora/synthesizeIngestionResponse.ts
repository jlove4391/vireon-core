import { produceDirectAnswer } from "./produceDirectAnswer.js";
import type { RetrievedMemoryRecord } from "./retrieveRelevantMemory.js";
import type { EloraAuthorityClassification, EloraResponseType, EloraStructuredIntent } from "./types.js";
import type { WorkOrderStatus } from "../state/workOrderState.js";

export interface SynthesizeIngestionResponseInput {
  finalWorkOrderStatus: WorkOrderStatus;
  intent: EloraStructuredIntent;
  authority: EloraAuthorityClassification;
  retrievedMemory: RetrievedMemoryRecord[];
}

export interface SynthesizedResponse {
  responseType: EloraResponseType;
  responseText: string;
}

/**
 * Produces the branch-appropriate response. READY_TO_ACT gets an actual
 * produced answer (produceDirectAnswer.ts); every other branch gets a
 * structured explanation of why work didn't proceed -- never an approval
 * workflow or a request for the user to grant permission (§6, §14.2:
 * "no approval queue/workflow of any kind").
 */
export function synthesizeIngestionResponse(input: SynthesizeIngestionResponseInput): SynthesizedResponse {
  switch (input.finalWorkOrderStatus) {
    case "READY_TO_ACT":
      return {
        responseType: "direct_answer",
        responseText: produceDirectAnswer(input.intent, input.retrievedMemory),
      };

    case "AWAITING_AUTHORIZATION":
      return {
        responseType: "escalation_required",
        responseText:
          `This request involves an external side effect and requires authorization before I can proceed: ${input.authority.reason} ` +
          `No action has been taken. This has been recorded as a WorkOrder awaiting authorization.`,
      };

    case "SETUP_REQUIRED":
      return {
        responseType: "setup_required",
        responseText:
          `I can't proceed yet -- required setup is missing: ${input.authority.required_setup ?? "unspecified"}. ` +
          `${input.authority.reason} This has been recorded so it can be picked up once that setup exists.`,
      };

    case "CAPABILITY_MISSING":
      return {
        responseType: "capability_missing",
        responseText: `I don't have the capability to do this: ${input.authority.reason} This request has been recorded for visibility.`,
      };

    case "REFUSED":
      return {
        responseType: "refused",
        responseText: `I'm not able to help with this request: ${input.authority.reason}`,
      };

    default:
      return {
        responseType: "clarification_required",
        responseText: "I need more information to proceed with this request.",
      };
  }
}
