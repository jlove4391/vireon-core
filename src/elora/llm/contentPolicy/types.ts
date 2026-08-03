// PR 3: provider-neutral content-policy boundary. Deliberately narrow --
// this does not attempt comprehensive secret discovery across arbitrary
// prose, and must not be presented as if it does. Caller-declared
// structured fields are the primary classification mechanism; narrow,
// explicitly-labeled defense-in-depth pattern detection is a secondary
// backstop, not the main line of defense.

export const MODEL_DATA_CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "SECRET"] as const;
export type ModelDataClassification = (typeof MODEL_DATA_CLASSIFICATIONS)[number];

const CLASSIFICATION_RANK: Readonly<Record<ModelDataClassification, number>> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  SECRET: 4,
};

/** The more severe of the two classifications -- classification only ever escalates, never downgrades, as more signals are folded in. */
export function maxClassification(a: ModelDataClassification, b: ModelDataClassification): ModelDataClassification {
  return CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b;
}

/**
 * A caller-declared structured field with its own known classification and
 * literal value -- the primary mechanism this boundary relies on. No live
 * caller supplies these yet (same "proves the mechanism, zero live
 * callers" posture as every other PR1/PR2/PR3 piece); wiring a real
 * caller's genuinely sensitive fields through this is a future PR's scope.
 */
export interface SensitiveField {
  name: string;
  classification: ModelDataClassification;
  value: string;
}

export interface Detection {
  kind: string;
  fieldName?: string;
}

export interface ClassifiedInput {
  classification: ModelDataClassification;
  detections: Detection[];
}

export type PolicyDecision =
  | { allowed: true; classification: ModelDataClassification; redactionNeeded: boolean }
  | { allowed: false; classification: ModelDataClassification; reason: string };
