import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { CORRELATION_ATTRIBUTES } from "../../src/telemetry/correlation.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import { ensureDeterministicLlmPath } from "../../test-utils/ensureDeterministicLlmPath.js";

/**
 * A SpanProcessor whose onEnd() throws synchronously -- the worst case for
 * a misbehaving exporter (worse than a real OTLP exporter, which reports
 * failure through an async callback rather than throwing). Used to prove
 * src/telemetry/correlation.ts's withSpan() truly never lets a broken
 * telemetry pipeline break message ingestion, rather than merely trusting
 * that OTel's own internals are fail-open.
 */
class ThrowingSpanProcessor implements SpanProcessor {
  onStart(): void {
    throw new Error("simulated telemetry failure: onStart");
  }
  onEnd(): void {
    throw new Error("simulated telemetry failure: onEnd");
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((span) => span.name === name);
}

function childrenOf(spans: ReadableSpan[], parent: ReadableSpan): ReadableSpan[] {
  return spans.filter((span) => span.parentSpanContext?.spanId === parent.spanContext().spanId);
}

describe("PR 0: observability foundation acceptance", () => {
  ensureDeterministicLlmPath();

  let ctx: SeededContext;
  const memoryExporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();

    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    });
    provider.register();
  });

  afterEach(() => {
    memoryExporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    await pool.end();
  });

  it("emits a root ingestion span and bounded, correctly-parented child spans carrying namespaced correlation ids", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for CORE memory v1",
      sourceSurface: "pr0-observability-test",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.finalWorkOrderStatus).toBe("READY_TO_ACT");
    expect(result.workOrderId).not.toBeNull();

    const spans = memoryExporter.getFinishedSpans();

    const root = findSpan(spans, "elora.ingest_user_message");
    expect(root).toBeDefined();
    expect(root!.attributes[CORRELATION_ATTRIBUTES.tenantId]).toBe(ctx.tenantId);
    expect(root!.attributes[CORRELATION_ATTRIBUTES.threadId]).toBe(result.threadId);
    expect(root!.attributes[CORRELATION_ATTRIBUTES.messageId]).toBe(result.messageId);
    expect(root!.attributes[CORRELATION_ATTRIBUTES.workOrderId]).toBe(result.workOrderId);

    const expectedChildNames = [
      "elora.persist_message",
      "elora.retrieve_memory",
      "elora.work_order_create",
      "elora.work_order_transition",
      "elora.authority_resolution",
      "elora.generate_response",
      "elora.receipt_write",
      "elora.propose_memory_candidates",
    ];
    for (const name of expectedChildNames) {
      expect(findSpan(spans, name), `expected a "${name}" span`).toBeDefined();
    }

    // Every AUTHORITY_CLASSIFIED-fan-out transition (INTENT_PARSED,
    // AUTHORITY_CLASSIFIED, READY_TO_ACT) is its own bounded span, all
    // direct children of the root -- not silently collapsed into one.
    const transitionSpans = spans.filter((span) => span.name === "elora.work_order_transition");
    expect(transitionSpans.length).toBe(3);
    expect(transitionSpans.map((span) => span.attributes["vireon.work_order.status_to"])).toEqual([
      "INTENT_PARSED",
      "AUTHORITY_CLASSIFIED",
      "READY_TO_ACT",
    ]);

    const persistMessageSpan = findSpan(spans, "elora.persist_message")!;
    expect(childrenOf(spans, root!)).toContainEqual(persistMessageSpan);
    for (const span of transitionSpans) {
      expect(childrenOf(spans, root!)).toContainEqual(span);
    }

    const receiptSpan = findSpan(spans, "elora.receipt_write")!;
    expect(receiptSpan.attributes[CORRELATION_ATTRIBUTES.receiptId]).toBe(result.actionReceiptId);

    // Trace privacy default: no span attribute anywhere in this trace may
    // contain the raw message content.
    for (const span of spans) {
      for (const value of Object.values(span.attributes)) {
        if (typeof value === "string") {
          expect(value).not.toContain("Help me create a project plan");
        }
      }
    }
  });

  it("never fails message ingestion when the span processor itself throws synchronously on every span", async () => {
    const throwingProvider = new NodeTracerProvider({
      spanProcessors: [new ThrowingSpanProcessor()],
    });
    trace.disable();
    throwingProvider.register();

    try {
      const result = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        content: "Help me create a project plan for a second, distinct exporter-failure request",
        sourceSurface: "pr0-observability-test",
        sourceCorrelationId: randomUUID(),
        isSystemInitiated: true,
      });

      expect(result.finalWorkOrderStatus).toBe("READY_TO_ACT");
      expect(result.workOrderId).not.toBeNull();
      expect(result.actionReceiptId).not.toBeNull();
    } finally {
      await throwingProvider.shutdown();
      trace.disable();
      provider.register();
    }
  });
});
