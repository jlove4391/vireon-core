// Phase 4 §4.4: a narrow sanitization boundary around receipt inspection
// output only -- not a general tool-payload redaction framework (that
// belongs with the tool registry in Phase 5, once there's real tool
// output/credentials to protect). Zero redaction/sanitization
// infrastructure existed anywhere in the repo before this file (confirmed
// via repo-wide grep during Phase 4 planning) -- this is new code.
//
// Applied only to free-text fields that originate from user-supplied or
// generated message/error content (originalRequest.content, output
// content). Never applied to structured/enum fields (outcome, receipt_type,
// status, etc.) -- those aren't free text and redacting them would corrupt
// meaningful data rather than protect anything.

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\b(api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/gi,
  /\bpassword\s*[:=]\s*\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT-shaped
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64/hex-ish blobs
];

const REDACTED = "[REDACTED]";

/**
 * Redacts secret-like substrings from free text before it's returned in a
 * receipt inspection projection. Display-time only -- never mutates the
 * underlying persisted record.
 */
export function redactSecretLikeValues(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_LIKE_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  return sanitized;
}
