import type { SensitiveField } from "./types.js";

export interface RedactionResult<T> {
  redacted: T;
  redactionCount: number;
}

function redactStringValue(value: string, declaredFields: readonly SensitiveField[], countRef: { count: number }): string {
  let result = value;
  for (const field of declaredFields) {
    if (field.value.length === 0 || !result.includes(field.value)) {
      continue;
    }
    const occurrences = result.split(field.value).length - 1;
    result = result.split(field.value).join(`[REDACTED:${field.name}]`);
    countRef.count += occurrences;
  }
  return result;
}

function redactValue(value: unknown, declaredFields: readonly SensitiveField[], countRef: { count: number }): unknown {
  if (typeof value === "string") {
    return redactStringValue(value, declaredFields, countRef);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, declaredFields, countRef));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, redactValue(val, declaredFields, countRef)]),
    );
  }
  return value;
}

/**
 * Structurally deep-clones `input` and replaces any string leaf containing
 * a declared field's literal value with `[REDACTED:<fieldName>]`,
 * generically across any JSON-shaped input -- no per-operation extraction
 * function needed, works uniformly for every one of the six operations'
 * differently-shaped inputs. Narrow by design: only redacts declared field
 * values, not general free-text secret discovery (explicit non-goal, see
 * contentPolicy/types.ts's own doc comment).
 */
export function redactModelInput<T>(input: T, declaredFields: readonly SensitiveField[]): RedactionResult<T> {
  const countRef = { count: 0 };
  const redacted = redactValue(input, declaredFields, countRef) as T;
  return { redacted, redactionCount: countRef.count };
}
