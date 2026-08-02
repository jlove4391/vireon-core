import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// PR 0: backend-neutral OTel wiring. Depends only on @opentelemetry/api,
// sdk-node, exporter-trace-otlp-proto, resources, semantic-conventions --
// never a Phoenix-specific SDK -- so swapping the OTLP destination later
// never requires re-instrumentation. See docs/adr/0006-observability-foundation.md.
//
// Telemetry must never affect behavior (locked decision): export is
// batched and non-blocking (BatchSpanProcessor), and OTel's own SDK is
// fail-open by design -- exporter errors surface through its internal diag
// logger and never throw into application code. tests/integration/
// pr0.observability.test.ts proves this empirically with a
// deliberately-failing exporter rather than assuming it.
//
// start()/shutdown() are explicit, not import-time side effects, so tests
// can register their own in-memory provider/exporter instead of this
// singleton without needing a real OTLP collector.

let sdk: NodeSDK | undefined;

function buildSdk(): NodeSDK {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "vireon-core";

  return new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    // Passing `traceExporter` (rather than constructing a SpanProcessor
    // ourselves) lets NodeSDK wrap it in its own BatchSpanProcessor
    // internally -- batched, non-blocking export, per the locked decision
    // -- without this module needing to depend on @opentelemetry/sdk-trace-base
    // directly (that package is a test-only devDependency, used by
    // tests/integration/pr0.observability.test.ts's in-memory provider).
    traceExporter: new OTLPTraceExporter(endpoint ? { url: endpoint } : undefined),
  });
}

/** Idempotent: a second call while already started is a no-op. */
export function startTracing(): void {
  if (sdk) {
    return;
  }
  sdk = buildSdk();
  sdk.start();
}

/** Flushes and shuts down the exporter. Safe to call even if never started. */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) {
    return;
  }
  const current = sdk;
  sdk = undefined;
  await current.shutdown();
}

let shutdownHooked = false;

/**
 * Registers process-exit hooks that flush pending spans before the process
 * dies. Idempotent and separate from startTracing() so callers (e.g. the
 * test suite, which manages its own provider lifecycle) can opt in only
 * when running the real singleton SDK.
 */
export function registerTracingShutdownHooks(): void {
  if (shutdownHooked) {
    return;
  }
  shutdownHooked = true;

  const flush = () => {
    shutdownTracing().catch(() => {
      // Telemetry must never affect behavior, including at shutdown -- a
      // failed flush is not a reason to change the process exit path.
    });
  };

  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
  process.once("beforeExit", flush);
}
