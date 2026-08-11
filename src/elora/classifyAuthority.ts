import { AUTHORITY_OUTCOME_TO_REASON_CODE, type EloraAuthorityClassification, type EloraTaskType } from "./types.js";

export interface ClassifyAuthorityInput {
  content: string;
  taskType: EloraTaskType;
  /** Resolved (post-verification) project id from resolveContext.ts -- never the raw unvalidated input (§5.1). */
  resolvedProjectId: string | null;
}

// Deterministic cue-based classification -- no model calls (Phase 3 §5/§13).
// Rule precedence matters: refuse and capability_missing are checked before
// either escalate cue, floor-protected escalate is checked before ordinary
// escalate, and both are checked before the setup_required rule, so a
// request like "send an email and deploy to production" escalates
// floor-protected regardless of what task_type parseIntent assigned it.
// Exported (not just module-private) so ADR 0008 Realignment A's degraded-mode
// classifier (parseIntent.ts) and routing policy (resolveEloraRoute.ts) can
// reuse this exact safety-critical pattern rather than maintaining a second,
// possibly-drifting copy of it -- ADR 0008 §3 requires hard safety/refusal
// rules to stay active regardless of model availability.
export const REFUSE_CUE = /\b(steal|exfiltrat)\b/i;
const CAPABILITY_MISSING_CUE = /\b(3d|cad|manufactur|physical (prototype|part)|3d[- ]?print)\b/i;

// Phase 6C §4.1: the original single EXTERNAL_SIDE_EFFECT_CUE is split so
// resolveAuthorityWithHierarchy.ts can tell which escalate outcomes are
// permanently floor-protected (RMT / sensitive-data / irreversible-action --
// AUTHORITY_AND_DELEGATION.md §4/§5) versus ordinary escalates eligible for
// standing-authorization resolution. Floor-protected is checked first.
const FLOOR_PROTECTED_ESCALATE_CUE =
  /\b(deploy|to production|spend|payment|credentials?|delete (the )?(prod|database))\b/i;
const ORDINARY_ESCALATE_CUE = /\b(send (an )?email|calendar event)\b/i;

/**
 * Owns the setup_required trigger rule (§5.1): task_type === "implementation"
 * && no resolved project_id. This is a context-availability gate, not a
 * text classification, so it lives here alongside the other context-based
 * authority branches rather than in parseIntent.ts.
 */
export function classifyAuthority(input: ClassifyAuthorityInput): EloraAuthorityClassification {
  if (REFUSE_CUE.test(input.content)) {
    return {
      outcome: "refuse",
      requires_human_gatekeeper: true,
      reason: "Request pattern matches a refused action (credential theft / exfiltration).",
      reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.refuse,
      risk_level: "high",
      required_setup: null,
      floorProtected: false,
    };
  }

  if (CAPABILITY_MISSING_CUE.test(input.content)) {
    return {
      outcome: "capability_missing",
      requires_human_gatekeeper: false,
      reason: "Request requires physical-world capability (manufacturing/CAD/3D) the runtime does not have.",
      reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.capability_missing,
      risk_level: "low",
      required_setup: null,
      floorProtected: false,
    };
  }

  if (FLOOR_PROTECTED_ESCALATE_CUE.test(input.content)) {
    return {
      outcome: "escalate",
      requires_human_gatekeeper: true,
      reason:
        "Request matches an RMT / sensitive-data / irreversible-action pattern that is permanently ineligible for standing pre-authorization.",
      reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.escalate,
      risk_level: "high",
      required_setup: null,
      floorProtected: true,
    };
  }

  if (ORDINARY_ESCALATE_CUE.test(input.content)) {
    return {
      outcome: "escalate",
      requires_human_gatekeeper: true,
      reason: "Request involves an external side effect requiring authorization before proceeding.",
      reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.escalate,
      risk_level: "high",
      required_setup: null,
      floorProtected: false,
    };
  }

  if (input.taskType === "implementation" && !input.resolvedProjectId) {
    return {
      outcome: "setup_required",
      requires_human_gatekeeper: false,
      reason: "Implementation task requires a project scope, and none was resolved for this request.",
      reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.setup_required,
      risk_level: "medium",
      required_setup: "project_id",
      floorProtected: false,
    };
  }

  return {
    outcome: "act_and_report",
    requires_human_gatekeeper: false,
    reason: "Safe internal action (planning/drafting/analysis) with no external side effects.",
    reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.act_and_report,
    risk_level: "low",
    required_setup: null,
    floorProtected: false,
  };
}
