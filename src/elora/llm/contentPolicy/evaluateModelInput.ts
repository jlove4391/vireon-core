import { maxClassification, type ClassifiedInput, type Detection, type ModelDataClassification, type PolicyDecision, type SensitiveField } from "./types.js";

// Narrow, explicitly-labeled defense-in-depth patterns -- one obvious,
// high-signal secret shape each, not general secret discovery. Deliberately
// small; expanding this list is a real decision for a future PR, not
// something to grow unboundedly here.
const DETECTION_PATTERNS: ReadonlyArray<{ kind: string; classification: ModelDataClassification; pattern: RegExp }> = [
  { kind: "private_key_block", classification: "SECRET", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { kind: "bearer_token", classification: "RESTRICTED", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/i },
  { kind: "aws_access_key_id", classification: "RESTRICTED", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

export interface EvaluateModelInputRequest {
  /** Serialized representation of what will be sent to the model -- the defense-in-depth scan runs over this, never over raw structured fields directly. */
  serializedContent: string;
  /** Caller-declared structured fields -- the primary classification mechanism. Empty by default; no live caller supplies these yet. */
  declaredFields?: SensitiveField[];
  /** This process's own configured provider secrets -- defense-in-depth against a request accidentally echoing them back at a provider. */
  configuredSecrets?: string[];
}

/**
 * Classifies a would-be model request. Default is INTERNAL, not PUBLIC --
 * the same retroactive-assumption reasoning migrations/0015 applies to
 * pre-existing rows applies prospectively too: not as loose as PUBLIC, not
 * presumptively over-cautious like CONFIDENTIAL+ for a request nothing has
 * flagged. Classification only ever escalates as signals are folded in,
 * never downgrades.
 */
export function evaluateModelInput(request: EvaluateModelInputRequest): ClassifiedInput {
  let classification: ModelDataClassification = "INTERNAL";
  const detections: Detection[] = [];

  for (const field of request.declaredFields ?? []) {
    classification = maxClassification(classification, field.classification);
    detections.push({ kind: "declared_field", fieldName: field.name });
  }

  for (const { kind, classification: patternClassification, pattern } of DETECTION_PATTERNS) {
    if (pattern.test(request.serializedContent)) {
      classification = maxClassification(classification, patternClassification);
      detections.push({ kind });
    }
  }

  for (const secret of request.configuredSecrets ?? []) {
    if (secret.length > 0 && request.serializedContent.includes(secret)) {
      classification = maxClassification(classification, "SECRET");
      detections.push({ kind: "configured_secret_value" });
    }
  }

  return { classification, detections };
}

export interface DecideContentPolicyRequest {
  classifiedInput: ClassifiedInput;
  targetProvider: string;
  /** Providers approved to receive CONFIDENTIAL content. Env-configurable, not per-tenant (out of scope for this PR -- see providerSelection.ts's own doc comment). */
  approvedProvidersForConfidential: readonly string[];
  /** Explicit caller opt-in required for RESTRICTED to pass -- absent means fail-closed. No live caller sets this yet. */
  restrictedAllowed?: boolean;
}

/**
 * SECRET is always denied. RESTRICTED fails closed unless an explicit
 * policy permits it. CONFIDENTIAL is allowed only through a configured
 * approved provider. PUBLIC/INTERNAL pass through untouched.
 */
export function decideContentPolicy(request: DecideContentPolicyRequest): PolicyDecision {
  const { classification } = request.classifiedInput;

  if (classification === "SECRET") {
    return {
      allowed: false,
      classification,
      reason: "SECRET-classified content may never be transmitted to an external provider.",
    };
  }

  if (classification === "RESTRICTED") {
    if (!request.restrictedAllowed) {
      return {
        allowed: false,
        classification,
        reason: "RESTRICTED-classified content requires an explicit policy allow, which was not supplied.",
      };
    }
    return { allowed: true, classification, redactionNeeded: true };
  }

  if (classification === "CONFIDENTIAL") {
    if (!request.approvedProvidersForConfidential.includes(request.targetProvider)) {
      return {
        allowed: false,
        classification,
        reason: `CONFIDENTIAL-classified content is not approved for provider "${request.targetProvider}".`,
      };
    }
    return { allowed: true, classification, redactionNeeded: true };
  }

  return { allowed: true, classification, redactionNeeded: false };
}
