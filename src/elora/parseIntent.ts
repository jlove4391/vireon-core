import { REFUSE_CUE } from "./classifyAuthority.js";
import type { EloraStructuredIntent, EloraTaskType } from "./types.js";

// Phase 3 §5.1: task_type classification, unchanged from the pre-ADR-0008
// parseIntent.ts -- orthogonal to ADR 0008's route conservatism concern.
// task_type describes *what kind* of work a request is, independent of
// *whether* it becomes a WorkOrder; it remains load-bearing for the
// preserved WorkOrder pipeline (classifyAuthority.ts's setup_required rule
// keys off task_type === "implementation", and createWorkOrder.ts/
// proposeMemoryCandidates.ts still label by it), so it stays classified
// here regardless of which route this content resolves to.
const TASK_TYPE_CUES: ReadonlyArray<{ taskType: EloraTaskType; pattern: RegExp }> = [
  { taskType: "planning", pattern: /\b(project plan|road ?map|plan out|planning)\b/i },
  { taskType: "implementation", pattern: /\b(implement|build the|write code|deploy|in the repo)\b/i },
  { taskType: "documentation", pattern: /\b(document|write docs|documentation)\b/i },
  { taskType: "analysis", pattern: /\b(analyz|analys|review the data)\b/i },
  { taskType: "memory", pattern: /\b(remember|recall|memory)\b/i },
];

function classifyTaskType(content: string): EloraTaskType {
  return TASK_TYPE_CUES.find((cue) => cue.pattern.test(content))?.taskType ?? "unknown";
}

// Phase 5 §10: one narrow, deterministic pattern for explicit local
// Markdown creation requests -- structured extraction via capture groups,
// not general NLU. This is the one case ADR 0008 §3/§5 treats as
// "explicit, structurally recognizable syntax the code can establish
// without inference" -- it bypasses model-based routing entirely
// (resolveEloraRoute.ts checks this before ever calling the model or this
// degraded-mode fallback), reusing the existing WorkOrder/tool pipeline
// (dispatchTool.ts/runToolExecution.ts) completely unchanged, model
// available or not.
const ARTIFACT_CREATION_PATTERN = /create a local markdown artifact named (\S+\.md) containing:?\s*([\s\S]+)/i;

export interface ArtifactCreationRequest {
  filename: string;
  content: string;
}

export function detectArtifactCreationRequest(content: string): ArtifactCreationRequest | null {
  const match = ARTIFACT_CREATION_PATTERN.exec(content);
  if (!match) {
    return null;
  }
  const [, filename, artifactContent] = match;
  return { filename: filename!.trim(), content: artifactContent!.trim() };
}

// ADR 0008 §3: the one other exception to "no inference" in degraded mode --
// an explicit, structurally recognizable delegation instruction, validated
// independently of the model. Deliberately narrow (requires "have nexora",
// not any mention of Nexora) so ordinary conversation that happens to
// mention Nexora's name doesn't misfire as a delegation route.
const EXPLICIT_DELEGATION_PATTERN = /\bhave\s+nexora\b/i;

function baseIntent(content: string): Omit<EloraStructuredIntent, "route" | "interpretedIntent" | "confidence"> {
  return {
    taskDomain: null,
    requestedCapabilities: [],
    proposedDelegationTarget: null,
    requiresDurableWork: false,
    proposedToolNeeds: [],
    externalSideEffect: false,
    requires_clarification: false,
    clarifyingQuestion: null,
    task_type: classifyTaskType(content),
    summary: content.slice(0, 200),
  };
}

export interface ParseIntentDegradedOptions {
  /**
   * ADR 0008: a scheduled trigger firing (fireDueTriggers.ts) is
   * pre-authorized background work, not an ad-hoc conversational message --
   * its whole reason for existing is to produce durable, trackable work
   * each time it fires. Degraded mode's conservative "converse" default is
   * calibrated for live user text, where inferring durable_work from casual
   * phrasing would be wrong; it is NOT calibrated for synthetic,
   * system-authored trigger content, where the opposite failure (a trigger
   * that silently stops creating WorkOrders the moment no model provider is
   * configured) would defeat an existing, working feature. When true, the
   * conservative default becomes durable_work instead of converse -- the
   * two explicit structural exceptions and the hard refusal rule below
   * still take precedence and apply identically either way.
   */
  isSystemInitiated?: boolean;
}

/**
 * ADR 0008 §3: the degraded-routing-mode classifier -- used only when
 * model-backed interpretation (resolveEloraRoute.ts's primary path) is
 * unavailable or fails. Deliberately conservative: no new tool execution,
 * no implicit specialist delegation inferred from natural language, no new
 * WorkOrder created from inferred intent, no consequential action. The
 * only routes this function can ever produce beyond the conservative
 * default are the two explicit, structurally recognizable exceptions (the
 * artifact-creation pattern, the "have Nexora" delegation pattern) and the
 * existing hard refusal rule -- all three validated independently of any
 * model, and all three already deterministic policy today, per ADR 0008
 * §3's own requirement that hard safety rules remain active regardless of
 * model availability.
 *
 * This function does NOT replace resolveEloraRoute.ts's artifact-pattern
 * bypass (that check happens once, before either path runs) -- it repeats
 * the check here too so this function remains independently correct and
 * testable as "the degraded-mode classifier," not reliant on a caller
 * having already filtered artifact requests out.
 */
export function parseIntentDegraded(content: string, options?: ParseIntentDegradedOptions): EloraStructuredIntent {
  const artifactMatch = detectArtifactCreationRequest(content);
  if (artifactMatch) {
    return {
      ...baseIntent(content),
      route: "tool_assisted",
      interpretedIntent: `Create a local Markdown artifact named ${artifactMatch.filename}.`,
      confidence: 0.95,
      task_type: "artifact_creation",
      artifactRequest: artifactMatch,
    };
  }

  if (REFUSE_CUE.test(content)) {
    return {
      ...baseIntent(content),
      route: "refuse",
      interpretedIntent: "Request pattern matches a refused action (credential theft / exfiltration).",
      confidence: 0.9,
    };
  }

  if (EXPLICIT_DELEGATION_PATTERN.test(content)) {
    return {
      ...baseIntent(content),
      route: "delegate",
      interpretedIntent: content.slice(0, 200),
      confidence: 0.9,
      taskDomain: "engineering",
      proposedDelegationTarget: "nexora",
      requiresDurableWork: true,
    };
  }

  if (options?.isSystemInitiated) {
    return {
      ...baseIntent(content),
      route: "durable_work",
      interpretedIntent: content.slice(0, 200),
      confidence: 0.7,
      requiresDurableWork: true,
    };
  }

  return {
    ...baseIntent(content),
    route: "converse",
    interpretedIntent: content.slice(0, 200),
    confidence: 0.5,
  };
}
