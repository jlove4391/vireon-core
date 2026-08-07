import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

export const CLAIM_KINDS = [
  "observed",
  "user_asserted",
  "retrieved",
  "inferred",
  "predicted",
  "planned",
  "hypothetical",
] as const;

export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const claimKindSchema = z.enum(CLAIM_KINDS);

export const CLAIM_STATUSES = ["active", "stale", "disputed", "superseded", "retracted"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const claimStatusSchema = z.enum(CLAIM_STATUSES);

/**
 * A JSON-serializable value -- the only shape allowed to reach the
 * `claims.object_value` jsonb column. Implemented as a plain recursive
 * predicate (not zod's own z.lazy/z.record recursion) specifically so a
 * cyclic input is rejected deterministically via the `seen` set rather than
 * recursing forever. Rejects undefined, functions, symbols, bigint, and any
 * object whose prototype isn't Object.prototype/Array.prototype/null (class
 * instances, Date, Map, Set, ...) -- a class instance's own enumerable
 * properties might look JSON-shaped, but it is not itself a JSON value.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonValue(value: unknown, seen: Set<unknown>): value is JsonValue {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((item) => isJsonValue(item, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).every((item) => isJsonValue(item, seen));
  }
  // kind === "undefined" | "function" | "symbol" | "bigint", or a non-plain object.
  return false;
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>((value) => isJsonValue(value, new Set()), {
  message:
    "Value must be a JSON-serializable value (no undefined, functions, symbols, bigint, cyclic references, or class instances)",
});

/**
 * Matches the `claims` table exactly (migrations/0018). Deliberately no
 * `created_at` -- the bitemporal model is valid_from/valid_to (valid time)
 * plus recorded_at (transaction time); a third insertion timestamp would
 * just duplicate recorded_at.
 */
export const claimSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  subject_entity_id: uuidSchema.nullable().default(null),
  predicate: z.string().min(1),
  object_entity_id: uuidSchema.nullable().default(null),
  object_value: jsonValueSchema.nullable().default(null),
  claim_kind: claimKindSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  sensitivity: z.string().min(1).nullable().default(null),
  refresh_after: z.string().datetime().nullable().default(null),
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().nullable().default(null),
  recorded_at: z.string().datetime(),
  status: claimStatusSchema.default("active"),
  supersedes_claim_id: uuidSchema.nullable().default(null),
});

export type Claim = z.infer<typeof claimSchema>;
