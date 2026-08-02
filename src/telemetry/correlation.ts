import {
  context,
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanStatus,
  type Tracer,
} from "@opentelemetry/api";

// PR 0: namespaced correlation attributes. This project already has a
// `runs` table meaning WorkOrder execution attempts -- a bare `run_id`
// span attribute would collide with that concept, hence `vireon.*`
// namespacing throughout and the explicit execution_run/cognitive_run
// split below.
export const CORRELATION_ATTRIBUTES = {
  tenantId: "vireon.tenant.id",
  threadId: "vireon.thread.id",
  messageId: "vireon.message.id",
  workOrderId: "vireon.work_order.id",
  executionRunId: "vireon.execution_run.id",
  cognitiveRunId: "vireon.cognitive_run.id",
  authorityDecisionId: "vireon.authority_decision.id",
  toolInvocationId: "vireon.tool_invocation.id",
  receiptId: "vireon.receipt.id",
  memoryCandidateId: "vireon.memory_candidate.id",
} as const;

export type CorrelationAttributeKey = keyof typeof CORRELATION_ATTRIBUTES;

// Trace privacy default (locked decision): raw user messages, full
// prompts, memory contents, tool payloads, and secrets are never recorded
// by default. Only an explicit, development-only opt-in enables content
// capture -- off by default everywhere, including local dev.
export const CONTENT_CAPTURE_ENABLED = process.env.OTEL_CAPTURE_CONTENT === "true";

/**
 * Sets only the namespaced correlation attributes that are present
 * (non-null/undefined) on the given span. IDs/types/statuses/counts only --
 * callers must never pass raw message/prompt/memory content through here.
 */
export function setCorrelationAttributes(
  span: Span,
  attributes: Partial<Record<CorrelationAttributeKey, string | null | undefined>>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null) {
      span.setAttribute(CORRELATION_ATTRIBUTES[key as CorrelationAttributeKey], value);
    }
  }
}

/**
 * Only set a content-bearing span attribute when the dev-only opt-in is
 * active. No-op otherwise -- callers should still only reach for this on
 * genuinely content-bearing fields (never as a default path).
 */
export function setContentAttributeIfEnabled(span: Span, key: string, value: string): void {
  if (CONTENT_CAPTURE_ENABLED) {
    span.setAttribute(key, value);
  }
}

// Every telemetry bookkeeping call below (span creation, status, exception
// recording, end) is individually guarded rather than wrapping fn() itself
// in a try/catch. That distinction matters: fn() must run exactly once,
// unconditionally -- if a broken span processor's onStart() throws
// *during span creation*, tracer.startActiveSpan() never even invokes its
// callback, so a try/catch placed only around fn()'s own invocation (as an
// earlier version of this file did) would never run and the throw would
// still propagate. Falling back to a second, retried fn() call after a
// telemetry failure would risk a genuine double side effect (e.g.
// re-inserting a WorkOrder) -- so instead, span machinery is decomposed
// (startSpan, not startActiveSpan) so fn() itself is never inside a
// telemetry try/catch at all, only telemetry's own bookkeeping calls are.

/** A non-recording span, used when real span creation itself fails. */
function noopSpan(): Span {
  return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
}

function startSpanSafely(tracer: Tracer, spanName: string, attributes: Attributes): Span {
  try {
    return tracer.startSpan(spanName, { attributes });
  } catch {
    // Telemetry must never affect behavior -- deliberately swallowed.
    return noopSpan();
  }
}

function setStatusSafely(span: Span, status: SpanStatus): void {
  try {
    span.setStatus(status);
  } catch {
    // Telemetry must never affect behavior -- deliberately swallowed.
  }
}

function recordExceptionSafely(span: Span, error: unknown): void {
  try {
    span.recordException(error as Error);
  } catch {
    // Telemetry must never affect behavior -- deliberately swallowed.
  }
}

function endSpanSafely(span: Span): void {
  try {
    span.end();
  } catch {
    // Telemetry must never affect behavior -- deliberately swallowed.
  }
}

/**
 * Wraps `fn` in an active span: records exceptions and an ERROR status on
 * throw, always ends the span. Reused by PR 0's pipeline instrumentation
 * and PR 1's cognitive-run transition spans so both follow one shape.
 *
 * Telemetry must never affect behavior: this helper only ever wraps `fn`'s
 * execution and re-throws `fn`'s own errors unchanged -- it never
 * swallows, alters, or introduces an error of its own into the wrapped
 * call itself, and fn() always runs exactly once regardless of whether
 * span creation, status-setting, or span-ending fail. See the block
 * comment above for why every telemetry call is individually guarded
 * rather than wrapping fn() in a try/catch.
 */
export async function withSpan<T>(
  tracerName: string,
  spanName: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer: Tracer = trace.getTracer(tracerName);
  const span = startSpanSafely(tracer, spanName, attributes);
  const activeContext = trace.setSpan(context.active(), span);

  return context.with(activeContext, async () => {
    try {
      const result = await fn(span);
      setStatusSafely(span, { code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      recordExceptionSafely(span, error);
      setStatusSafely(span, { code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      endSpanSafely(span);
    }
  });
}
