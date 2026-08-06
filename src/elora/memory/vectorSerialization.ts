/**
 * PR 6 §9: narrowly owned helpers for the boundary between the logical
 * TypeScript vector shape (`number[]`, memoryEmbeddingSchema.embedding) and
 * pgvector's own text wire format (a bracketed, comma-separated list, e.g.
 * "[0.1,0.2,0.3]") as returned by node-postgres with no registered type
 * parser. This is the only place in the codebase that should parse or
 * construct that text form -- every other module works with `number[]`.
 */

/** Builds the literal text pgvector expects on the wire, for use with an explicit `$1::vector` cast. */
export function serializeVector(vector: number[]): string {
  if (vector.length === 0) {
    throw new Error("serializeVector: vector must not be empty");
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error(`serializeVector: vector contains a non-finite value (${value})`);
    }
  }
  // Plain string interpolation of already-validated finite numbers -- no
  // eval, no dynamic code execution of any kind.
  return `[${vector.join(",")}]`;
}

/** Parses pgvector's bracketed text representation back into a real `number[]`, never via `eval`. */
export function parseVector(value: unknown): number[] {
  if (typeof value !== "string") {
    throw new Error(`parseVector: expected a string from the database, got ${typeof value}`);
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`parseVector: malformed vector text (missing brackets): ${trimmed.slice(0, 80)}`);
  }

  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) {
    throw new Error("parseVector: vector must not be empty");
  }

  const result: number[] = [];
  for (const rawPart of inner.split(",")) {
    const part = rawPart.trim();
    // Number("") is 0, not NaN -- an explicit empty-component check catches
    // "1,,2"-style malformed text that Number.isFinite alone would silently
    // accept as a legitimate zero.
    if (part.length === 0) {
      throw new Error(`parseVector: malformed vector text (empty component): ${trimmed.slice(0, 80)}`);
    }
    const parsed = Number(part);
    if (!Number.isFinite(parsed)) {
      throw new Error(`parseVector: malformed or non-finite value in vector text: "${part}"`);
    }
    result.push(parsed);
  }

  return result;
}
