# ADR 0001: Ground-Zero Architecture

## Status

Accepted

## Date

2026-07-03

## Decision

Vireon CORE will begin as a local-first modular monolith built primarily with TypeScript / Node.js, PostgreSQL 17 + pgvector, Redis 7.4, and a bounded Python workspace-execution layer.

The initial architecture will prioritize deterministic state, explicit schemas, database-backed work orders, authority decisions, immutable receipts, memory candidates, and bounded execution before introducing distributed services, cloud orchestration, external integrations, or autonomous agent execution.

This decision establishes the ground-zero architecture for the Vireon CORE Alpha runtime.

## Context

Vireon CORE is a state-centric relational operating runtime for human-AI collaboration. Its target function is to coordinate cognitive agents, persist strict execution audit trails, isolate tenant-scoped state, govern tool execution, and support durable memory-aware workflows.

The system must eventually support ELORA as the executive intelligence interface, Nexora as the engineering execution runtime, specialist agents, governed tools, memory, authority decisions, receipts, sandboxing, and delegation.

However, building the agent layers before the runtime foundation would create unnecessary risk:

* Hidden prompt loops instead of inspectable state
* Untraceable agent actions
* Weak tenant boundaries
* Unclear authority decisions
* Fake execution artifacts
* Race conditions
* State drift
* Untestable orchestration
* Premature distributed complexity

The first version of CORE must therefore prove the execution spine before expanding into sophisticated agent behavior.

The minimum execution spine is:

`Raw ELORA Input` -> `Structured Task Parse` -> `WorkOrder Creation` -> `AuthorityDecision Creation` -> `State Transition` -> `ActionReceipt` -> `MemoryCandidate`

## Doctrine and Decision Hierarchy

When repository documents, refinement notes, roadmap material, or implementation prompts appear to conflict, apply this hierarchy:

1. Active user implementation prompt
2. Accepted ADRs
3. `AGENTS.md`
4. `README.md`
5. `/docs/architecture/*`
6. `ELORA.md` and `NEXORA.md`
7. Roadmaps and refinement docs
8. Vision, thesis, product, and long-horizon planning docs

Vision documents describe direction. They do not authorize implementation.

Proposed technologies, frameworks, agents, workflows, or product surfaces are not canonical until accepted in an ADR or explicitly scoped in the active implementation prompt.

Active tasking is supplied manually by the user in implementation prompts. Coding agents must not infer the active task or current phase from stable doctrine documents.

## Canonical vs. Proposed vs. Deferred vs. Vision

This ADR distinguishes between four classes of project material:

### Canonical

Canonical decisions are accepted implementation constraints for the current ground-zero architecture.

Canonical ground-zero choices include:

* TypeScript / Node.js deterministic runtime
* PostgreSQL 17 + pgvector durable state
* Redis 7.4 for short-lived locks and ephemeral coordination only
* Bounded Python workspace-execution layer
* Modular monolith before distributed services
* Raw parameterized SQL through `node-postgres` (`pg`)
* Zod runtime validation
* Database-level tenancy through PostgreSQL RLS and transaction-scoped tenant context
* Append-only receipts and audit records
* Memory candidates before durable memory writes

### Proposed

Proposed items may be evaluated later, but they are not implementation defaults.

Proposed items require either explicit task scope or a new ADR before being introduced.

### Deferred

Deferred items may be useful later but are intentionally excluded from the ground-zero implementation.

Deferred items should not be introduced to "future-proof" the repo.

### Vision

Vision material defines long-term direction, product identity, and future capabilities.

Vision material is not implementation scope.

Examples include the mature multi-agent society, Tech Bay, Crown Ledger, War Room, advanced council-room routing, expanded TCHAI concepts, mature UI surfaces, and large-scale organizational workflows.

These may shape long-term design, but they must not leak into ground-zero implementation unless explicitly scoped.

## Architectural Decision

The CORE Alpha runtime will use a modular monolith architecture.

The system will be organized into clear internal modules rather than separate distributed services.

The initial runtime layers are:

### 1. TypeScript / Node.js Deterministic Runtime

Owns:

* State orchestration
* Schema validation
* Database access
* Authority decisions
* Receipts
* Work orders
* Identity and tenancy boundaries
* Deterministic run lifecycle

### 2. PostgreSQL 17 + pgvector

Owns:

* Durable state
* Tenant isolation
* Work orders
* Run records
* Authority decisions
* Receipts
* Memory candidates
* Memory records
* Future vector retrieval through pgvector

### 3. Redis 7.4

Owns:

* Short-lived locks
* Ephemeral coordination
* Local runtime synchronization

Redis does not own durable CORE state.

### 4. Python Workspace Execution Layer

Owns:

* Bounded local code workspaces
* Patch application
* Subprocess validation
* Lint/typecheck/test execution
* Potentially unsafe execution routines

Python does not connect directly to the primary database pool.

### 5. Stable Repository Doctrine

The repository doctrine is distributed across stable files:

* `README.md` defines repository orientation
* `AGENTS.md` defines AI coding-agent operating rules
* `ELORA.md` defines ELORA runtime boundaries
* `NEXORA.md` defines Nexora runtime boundaries
* Architecture docs define the CORE runtime model
* ADRs record key architectural decisions

## Architecture Shape

```text
+--------------------------------------------------------+
|              TypeScript State Orchestrator             |
|   Zod Validation -> State Kernel -> Database Pools      |
+---------------------------+----------------------------+
                            |
          Strict Boundary IPC / Process Spawn
                            |
+---------------------------v----------------------------+
|               Isolated Python Sandboxes                |
|   Git Worktrees -> Subprocess Lints -> Test Run Traps   |
+--------------------------------------------------------+

+--------------------------------------------------------+
|                    PostgreSQL 17                       |
| WorkOrders -> Runs -> Authority -> Receipts -> Memory   |
| pgvector-ready memory retrieval                         |
| Row-Level Security / Tenant Isolation                   |
+--------------------------------------------------------+

+--------------------------------------------------------+
|                       Redis 7.4                        |
| Short-lived locks / ephemeral coordination only          |
+--------------------------------------------------------+
```

## Core Architectural Rules

### 1. State Before Agents

The system must establish explicit state transitions before advanced agent behavior.

ELORA, Nexora, and future agents must operate through work orders, authority decisions, receipts, memory candidates, and tool governance.

Agents do not bypass CORE state.

### 2. Work Orders Before Execution

Human or system intent must be converted into structured work orders before execution.

Work orders provide scope, traceability, ownership, authority context, and execution lifecycle.

### 3. Authority Before External Side Effects

External side effects require authority classification.

Supported authority outcomes are:

* `act`
* `act_and_report`
* `escalate`
* `setup_required`
* `capability_missing`
* `refuse`

The system must not default to approval-first behavior, but it must not execute external side effects without authority classification.

### 4. Receipts Are Append-Only

Receipts and audit records are immutable.

Corrections, reversals, and supersessions must create new records that reference prior records.

Historical records must not be mutated in place.

### 5. Memory Candidates Before Durable Memory

The runtime must not blindly write long-term memory.

New memory should first become a memory candidate that can be reviewed, rejected, consolidated, promoted, or superseded.

### 6. Database-Level Tenancy

Tenant-scoped data access must be enforced at the database boundary.

Application logic alone is not sufficient.

Tenant-scoped operations must use transaction-scoped tenant context through:

```sql
SELECT set_config('vireon.current_tenant_id', $1, true)
```

PostgreSQL row-level security should enforce tenant isolation for tenant-scoped tables.

### 7. Runtime Validation at Boundaries

All payloads crossing runtime boundaries must be validated with Zod schemas.

TypeScript types alone are not sufficient for user-provided data, model-returned data, database-loaded data, tool-returned data, or external inputs.

### 8. Redis Is Not Durable State

Redis may be used for short-lived locks, cache, and ephemeral coordination.

Redis must not become the source of truth for CORE work orders, authority decisions, receipts, memory, or execution history.

### 9. Python Does Not Own CORE State

Python may execute bounded workspace operations.

Python must not connect directly to the primary database pool.

Python execution results must return to the TypeScript runtime for validation, persistence, authority handling, and receipt generation.

### 10. Local First, Distributed Later

The first implementation must prove the local deterministic execution spine before introducing distributed services, gRPC, Go orchestration, Kubernetes, cloud production infrastructure, or multi-service deployment complexity.

## Technology Choices

### TypeScript / Node.js

Chosen for:

* Strong compatibility with web/runtime tooling
* Fast iteration
* Excellent schema validation through Zod
* Straightforward integration with PostgreSQL and Redis
* Good fit for deterministic orchestration and API/runtime code

Tradeoff:

* Node.js is not ideal for all high-concurrency or CPU-heavy workloads.
* CPU-heavy or unsafe code execution will be isolated into Python runners or future sandbox services.

### PostgreSQL 17 + pgvector

Chosen for:

* Durable relational state
* Transaction support
* Row-level security
* JSONB support
* Strong indexing options
* Future vector retrieval through pgvector
* Ability to support both structured records and memory retrieval in the same early database

Tradeoff:

* A single database can become overloaded if used carelessly.
* Graph-style memory may eventually require graph extensions or a separate graph database.
* Early design must avoid turning PostgreSQL into an unstructured dumping ground.

### Redis 7.4

Chosen for:

* Short-lived locks
* Runtime coordination
* Ephemeral state mutation guards
* Simple local development

Tradeoff:

* Redis is not the source of truth.
* Any data that must survive restart, audit, replay, or review belongs in PostgreSQL.

### Python Workspace Execution Layer

Chosen for:

* Subprocess orchestration
* Code workspace handling
* Test/lint/typecheck execution
* Future sandbox evaluation utilities
* Useful ecosystem for AST analysis and code inspection

Tradeoff:

* Python must remain bounded.
* Python must not own CORE durable state.
* Python execution must be isolated and mediated by the TypeScript runtime.

### Zod

Chosen for:

* Runtime validation
* Schema readability
* TypeScript type inference
* Clear data boundary enforcement

Tradeoff:

* Zod schemas must remain well-organized to avoid duplication and drift.
* Database migrations and Zod schemas must be kept aligned.

### node-postgres (`pg`)

Chosen for:

* Explicit SQL control
* Parameterized queries
* Direct transaction management
* Compatibility with PostgreSQL RLS and transaction-scoped tenant context

Tradeoff:

* Raw SQL requires discipline.
* Query helpers and migration conventions are necessary to avoid duplication and unsafe query patterns.

## Decision Status of Adjacent Technologies

The following technologies are not rejected, but they are not part of the ground-zero architecture unless separately ratified by an ADR or explicitly scoped in an active implementation prompt.

### LangGraph

Status: Proposed / Evaluation Candidate

LangGraph may become useful for future stateful agent workflows, checkpointing, graph-based execution flows, and interruptible human-in-the-loop workflows.

It is not canonical for ground zero.

The current ground-zero default remains a deterministic TypeScript state kernel with persisted state records.

### LlamaIndex

Status: Proposed / Deferred

LlamaIndex may become useful for future retrieval pipelines, document ingestion, indexing, or memory augmentation.

It is not canonical for ground zero.

Memory candidates, memory records, and retrieval contracts should first be modeled explicitly in CORE-owned schemas.

### MCP Servers

Status: Proposed Connector Standard

MCP may become useful as a connector protocol for tools and external capabilities.

MCP must not replace internal authority decisions, receipts, tool permission scopes, or policy enforcement.

MCP is not canonical for ground zero.

### OpenTelemetry

Status: Likely Future Canonical / Deferred

OpenTelemetry is likely appropriate for future observability, tracing, metrics, and replay analysis.

It is deferred until the local state machine, receipts, and run records exist.

### Redis Streams

Status: Deferred

Redis Streams may become useful for eventing, workers, or asynchronous pipelines.

Redis Streams are not part of the ground-zero durable execution model.

Redis remains limited to locks and ephemeral coordination unless a future ADR changes that decision.

### NATS

Status: Deferred

NATS may become useful for distributed eventing or service decoupling after the modular monolith outgrows local orchestration.

It is not part of the ground-zero architecture.

### Temporal

Status: Deferred

Temporal may become useful for durable workflows, long-running jobs, retries, and distributed orchestration.

It is deferred until the local state machine demonstrates clear limits that justify introducing a workflow engine.

### Go / gRPC Runtime Kernel

Status: Deferred

Go/gRPC may become useful for high-concurrency runtime components, binary service boundaries, or dedicated orchestration services.

It is deferred because it would introduce premature distributed complexity before the execution spine is proven.

### Firecracker / gVisor / Kata

Status: Deferred for Stronger Sandbox Isolation

These may become appropriate for production-grade sandbox isolation.

They are not part of ground zero.

Initial sandboxing should begin with bounded local workspace controls and later containerized isolation before introducing microVM infrastructure.

### Other Event/Workflow Engines

Status: Not Implementation Defaults

Redis Streams, NATS, Temporal, and similar event/workflow engines must not be introduced to future-proof the system.

They require a clear workload, failure mode, or scaling pressure and should be evaluated in a future ADR.

## Rejected or Deferred Alternatives

### Go + gRPC Kernel

Deferred.

A Go/gRPC kernel may become useful later for high-concurrency orchestration, binary service boundaries, long-running workers, or distributed runtime separation.

It is not part of the ground-zero implementation because it would introduce premature distributed complexity before the execution spine is proven.

### Microservices

Deferred.

The Alpha runtime will remain a modular monolith until there is clear pressure to split services.

Splitting services too early would increase coordination complexity, testing burden, deployment burden, and failure modes.

### Kubernetes / Cloud-Native Production Infrastructure

Deferred.

The initial runtime must prove local correctness before production deployment complexity is introduced.

### Heavy ORMs

Rejected for the initial architecture.

Prisma, Drizzle, TypeORM, Sequelize, and similar heavy abstraction layers are not allowed unless the architecture is explicitly revised.

CORE requires explicit transaction handling, tenant context, RLS alignment, and careful SQL control.

### Redis as Durable State

Rejected.

Redis must not own work orders, receipts, memory, authority decisions, or execution history.

### Python as Primary Orchestrator

Rejected.

Python is useful for bounded workspace execution but should not own tenancy, durable state, receipts, or authority decisions.

### Agent-First Architecture

Rejected.

ELORA and Nexora must be runtime systems operating through CORE state and authority, not standalone prompt personas or unconstrained agents.

## Vision Boundary

Long-term Vireon CORE concepts such as the multi-agent society, council rooms, Tech Bay, Crown Ledger, War Room, Auditor Agent, proactive briefings, mature UI surfaces, and full TCHAI workflow expression are valid product direction.

They are not ground-zero implementation scope.

These concepts should be treated as horizon architecture unless explicitly scoped in an active implementation prompt or ratified by a future ADR.

Implementation prompts must not pull these concepts into early code simply because they appear in vision or refinement documents.

## Consequences

### Positive Consequences

This architecture:

* Reduces early complexity
* Improves debuggability
* Keeps state explicit
* Makes receipts and audit history foundational
* Supports local-first development
* Reduces coding-agent drift
* Keeps tenant isolation close to the database
* Allows future ELORA and Nexora layers to inherit stable runtime contracts
* Supports future extraction into services after behavior is proven

### Negative Consequences

This architecture:

* May feel slower than building a chatbot/demo first
* Requires upfront discipline around schemas and transactions
* Requires careful migration management
* May need later refactoring when service extraction becomes necessary
* May initially underuse specialized infrastructure such as Go, gRPC, Temporal, Kubernetes, or Firecracker

### Accepted Tradeoff

The system accepts slower-looking early progress in exchange for a stronger execution spine.

The priority is not to produce a flashy demo.

The priority is to create a trustworthy runtime that can execute, record, govern, retrieve, validate, and improve over time.

## Boundaries

### In Scope for Ground Zero

* Repo doctrine
* Schema contracts
* Local TypeScript runtime
* PostgreSQL database spine
* Redis lock layer
* Work orders
* Run state
* Authority decisions
* Action receipts
* Memory candidates
* Deterministic state machine
* Local verification
* Eventual bounded Python workspace execution

### Out of Scope for Ground Zero

* Production cloud deployment
* Distributed microservices
* Go/gRPC orchestration
* Kubernetes
* External model-provider calls
* Google Workspace integrations
* Unrestricted shell execution
* Autonomous production actions
* Advanced agent society behavior
* Full UI product surface
* Large-scale multi-tenant SaaS operations
* LangGraph
* LlamaIndex
* MCP servers
* OpenTelemetry
* Redis Streams
* NATS
* Temporal
* Firecracker/gVisor/Kata sandboxing

## Revisiting This Decision

This decision should be revisited when one or more of the following become true:

* The modular monolith creates clear concurrency bottlenecks
* Long-running jobs require durable workflow orchestration beyond the local state machine
* Sandbox workloads require stronger isolation than local subprocess/container boundaries
* Multiple independent teams need separate service ownership
* Runtime components need independent deployment cycles
* Customer-facing multi-tenant production requirements exceed the local architecture
* Go/gRPC or another service boundary becomes necessary for measurable performance or safety reasons
* A proposed orchestration, retrieval, connector, observability, eventing, or sandbox technology has a concrete workload that cannot be handled cleanly by the current architecture

Any revision must be recorded in a new ADR.

## Implementation Implications

Future implementation prompts and coding-agent tasks must follow this ADR.

This means:

* Do not introduce Go/gRPC unless explicitly authorized by a new decision
* Do not introduce heavy ORMs
* Do not bypass RLS or transaction-scoped tenant context
* Do not treat Redis as durable state
* Do not let Python connect directly to the primary database pool
* Do not build ELORA or Nexora as independent unconstrained agents
* Do not implement fake execution artifacts
* Do not expand beyond the active implementation task
* Do not introduce LangGraph, LlamaIndex, MCP servers, OpenTelemetry, Redis Streams, NATS, Temporal, Firecracker, gVisor, or Kata unless explicitly scoped or ratified
* Treat vision/refinement docs as directional unless they are converted into an accepted ADR, architecture document, or active task scope

## Future ADR Candidates

The following future ADRs may be useful when the relevant phase is reached:

* ADR 0002: Orchestration and Workflow Engine Evaluation
* ADR 0003: Memory Retrieval Architecture
* ADR 0004: Tool and Connector Layer
* ADR 0005: Sandbox Isolation Strategy
* ADR 0006: Observability and Replayable Runs
* ADR 0007: Event Bus and Background Worker Architecture
* ADR 0008: ELORA Runtime Boundary
* ADR 0009: Nexora Runtime Boundary

These are candidates, not active implementation tasks.

## Related Documents

* `/README.md`
* `/AGENTS.md`
* `/ELORA.md`
* `/NEXORA.md`
* `/docs/architecture/core-runtime.md`
* `/docs/adr/0001-ground-zero-architecture.md`
