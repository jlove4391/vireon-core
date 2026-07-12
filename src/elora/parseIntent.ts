import type { EloraStructuredIntent, EloraTaskType } from "./types.js";

// Deterministic cue-based matching -- no model calls, no overbuilt NLU
// (Phase 3 §13). Order matters: the first matching cue wins.
const TASK_TYPE_CUES: ReadonlyArray<{ taskType: EloraTaskType; pattern: RegExp }> = [
  { taskType: "planning", pattern: /\b(project plan|road ?map|plan out|planning)\b/i },
  { taskType: "implementation", pattern: /\b(implement|build the|write code|deploy|in the repo)\b/i },
  { taskType: "documentation", pattern: /\b(document|write docs|documentation)\b/i },
  { taskType: "analysis", pattern: /\b(analyz|analys|review the data)\b/i },
  { taskType: "memory", pattern: /\b(remember|recall|memory)\b/i },
];

const ACTIONABLE_CUE = /\b(help me|create|build|send|deploy|implement|analyz|write|make|do|steal|manufactur)\b/i;

/**
 * intent_type only ever resolves to work_order_candidate or informational
 * in Phase 3. clarification_required / setup_required / capability_missing
 * / refusal_required are declared type surface for future phases --
 * classifyAuthority.ts is the sole owner of those branches here (§5.1).
 */
export function parseIntent(content: string): EloraStructuredIntent {
  const taskTypeMatch = TASK_TYPE_CUES.find((cue) => cue.pattern.test(content));
  const taskType: EloraTaskType = taskTypeMatch?.taskType ?? "unknown";
  const isActionable = ACTIONABLE_CUE.test(content);

  if (!isActionable) {
    return {
      intent_type: "informational",
      task_type: taskType,
      confidence: 0.5,
      requires_clarification: false,
      summary: content.slice(0, 200),
    };
  }

  return {
    intent_type: "work_order_candidate",
    task_type: taskType,
    confidence: taskTypeMatch ? 0.85 : 0.6,
    requires_clarification: false,
    summary: content.slice(0, 200),
  };
}
