# ADR 0006: Observability Foundation (OpenTelemetry Adoption + Infrastructure Licensing)

Status: Accepted
Date: 2026-08-01
Supersedes: docs/adr/0001-ground-zero-architecture.md's "OpenTelemetry" section, and only that section -- no other decision in ADR 0001 is affected.

## Context

`docs/adr/0001-ground-zero-architecture.md` classified OpenTelemetry as "Likely Future Canonical / Deferred," listed it under "Out of Scope for Ground Zero," and stated: "Do not introduce ... OpenTelemetry ... unless explicitly scoped or ratified." ADR 0001 pre-registered this ADR number for exactly that ratification, as "ADR 0006: Observability and Replayable Runs" in its Future ADR Candidates list.

The Cognitive Plane PR 0 + PR 1 implementation handoff (2026-08-01), which begins building against the "Deep Technical Research Report: Building Elora as a Real-World Raphael," explicitly and exhaustively scopes OpenTelemetry adoption: specific packages, a specific initial OTLP destination, specific privacy defaults, and a specific deployment shape. Per AGENTS.md's doctrine hierarchy, a technology becomes canonical either via an accepted ADR or via explicit scoping in the active prompt -- the handoff prompt already satisfies the latter on its own. This ADR exists to close the loop formally rather than leave the decision resting on prompt-level scoping indefinitely, and to give the licensing determination below a durable, citable home (none existed before this ADR).

ADR 0001's own stated trigger for revisiting a deferred decision applies directly here: "The local state machine, receipts, and run records exist" (ADR 0001's own condition for OpenTelemetry specifically) is true as of Phase 2 and the Phase 6 series; cognitive-plane PR 1 adds a second, parallel run/state-machine record (`cognitive_runs`) that makes tracing valuable from its very first PR rather than retrofitted later.

## Decision

Adopt OpenTelemetry for distributed tracing across the CORE runtime, starting with the existing, stable ELORA ingestion pipeline (`src/elora/ingestUserMessage.ts`) before any cognitive-plane complexity exists to trace.

**Backend-neutral instrumentation.** Application code depends only on `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/resources`, and `@opentelemetry/semantic-conventions` -- never a vendor-specific SDK. The OTLP destination is swappable via `OTEL_EXPORTER_OTLP_ENDPOINT` alone; no re-instrumentation required to change it.

**Arize Phoenix, self-hosted, as the initial local-dev OTLP destination** -- see Infrastructure Licensing Decisions below. Wired as an optional Docker Compose profile (`observability`), not part of ordinary `docker compose up`.

**Telemetry must never affect behavior.** Batched, non-blocking export (`BatchSpanProcessor`, via `NodeSDK`'s `traceExporter` option); a graceful flush on process shutdown; a span-processor or exporter failure must never fail message ingestion, change an authority outcome, roll back a business transaction, block receipt generation, or alter response content. `src/telemetry/correlation.ts`'s `withSpan()` helper defensively isolates span bookkeeping (including `span.end()`) from the wrapped call's own control flow, rather than relying solely on the OTel SDK's own fail-open internals. This mirrors the governing research report's own §16.1 distinction: receipts are authoritative evidence, telemetry is a best-effort side channel, never the reverse.

**Trace privacy defaults.** No raw user messages, full prompts, memory contents, tool payloads, or secrets are recorded by default -- only IDs, types, durations, statuses, counts, sizes, model identifiers, and safe error classifications. Content capture requires an explicit, development-only opt-in (`OTEL_CAPTURE_CONTENT=true`), off by default everywhere including local dev.

**Namespaced correlation attributes** (`vireon.tenant.id`, `vireon.thread.id`, `vireon.message.id`, `vireon.work_order.id`, `vireon.execution_run.id`, `vireon.cognitive_run.id`, `vireon.authority_decision.id`, `vireon.tool_invocation.id`, `vireon.receipt.id`, `vireon.memory_candidate.id`) rather than ambiguous bare names -- this codebase already has a `runs` table meaning WorkOrder execution attempts, so a bare `run_id` span attribute would collide with that concept.

Every future PR that adds a new durable record type should extend this same namespaced attribute set rather than inventing a parallel convention.

## Infrastructure Licensing Decisions

This section is the durable log for infrastructure licensing determinations made during implementation. Entries are appended, never rewritten in place, as later infrastructure decisions are made.

**Arize Phoenix -- Elastic License 2.0 (2026-08-01).** Phoenix is self-hosted and operated internally by Vireon engineers for local development and internal observability. Elastic License 2.0's restriction targets providing the licensed software's functionality to third parties as a hosted or managed service; internal operation by Vireon engineers for Vireon's own internal use does not trigger that restriction. A future decision to expose Phoenix itself to customers, or to operate it as a service on customers' behalf, would require separate review under this same license and is explicitly out of scope for this determination.

## Consequences

- OpenTelemetry is no longer "Out of Scope" for this codebase; ADR 0001's other technology classifications (LangGraph, LlamaIndex, MCP, Redis Streams, NATS, Temporal, sandboxing) are unaffected and remain deferred exactly as ADR 0001 states.
- Every future PR touching the ingestion pipeline or a new durable-record lifecycle is expected to extend the existing span/attribute conventions in `src/telemetry/correlation.ts` rather than introducing a parallel tracing approach.
- A production (non-local-dev) OTLP collector deployment, trace-based evaluations, and model-specific OpenInference instrumentation remain out of scope for this ADR and PR 0; they are not blocked by it either, and may be scoped in a future ADR or active-prompt task when needed.
