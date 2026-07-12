CORE Runtime Architecture
Document: /docs/architecture/core-runtime.md
Project: Vireon CORE
Status: Draft v2 (refinements folded in from optimization audit)
Date: 2026-07-03

## 1. Purpose

This document defines the technical runtime model for Vireon CORE.

It does not define the full product vision, the mature multi-agent society, or the active
implementation phase. It defines the stable runtime primitives that ELORA, Nexora, tools,
memory, receipts, and future agents must use.

The purpose of this document is to prevent implementation drift by making the CORE runtime
explicit:

- what enters the runtime
- how input becomes structured state
- how state mutates
- how authority is classified
- how actions are recorded
- how memory candidates are created
- how tools are invoked
- how agents delegate work
- how tenant and workspace boundaries are enforced
- how TypeScript, PostgreSQL, Redis, and Python relate to one another

This file inherits from ADR 0001: Ground-Zero Architecture and should remain consistent
with README.md and AGENTS.md.

## 2. Runtime Position

CORE is the state-centric relational runtime layer between user/system input, durable
relational state, ephemeral coordination, bounded execution, and future agent behavior.

At ground zero, the CORE runtime is primarily a TypeScript / Node.js orchestration layer.

The runtime coordinates:

- PostgreSQL 17 + pgvector for durable relational state
- Redis 7.4 for short-lived locks and ephemeral coordination
- Python workspace execution for bounded local validation and potentially unsafe routines
- future agent layers such as ELORA and Nexora
- future tools and connector surfaces

The runtime is not a chatbot loop. It is not a prompt wrapper. It is not a distributed service
mesh. It is the deterministic execution spine that converts input into governed state transitions,
receipts, and memory candidates.

### 2.1 Runtime Placement

```
Human/System Input
 |
 v
TypeScript CORE Runtime
 |
 +--> PostgreSQL 17 + pgvector          durable state
 |
 +--> Redis 7.4                         locks / ephemeral coordination
 |
 +--> Python Workspace Execution        bounded validation / code routines
 |
 +--> Future Agent Layers               ELORA, Nexora, specialist agents
```

### 2.2 Runtime Ownership

The TypeScript runtime owns:

- runtime schemas
- state transition validation
- work order creation
- run lifecycle
- authority decision creation
- receipt creation
- memory candidate creation
- database transaction orchestration
- Redis lock acquisition and release
- tool invocation routing
- agent delegation records
- validation of Python return payloads

Python does not own CORE durable state. Redis does not own CORE durable state. Agent
prompts do not own CORE durable state.

## 3. Canonical Execution Spine

The canonical execution spine defines how input moves through CORE.

Ground-zero CORE should begin with a simple, inspectable synchronous orchestration loop
before introducing distributed workers, workflow engines, external connectors, or advanced
agent delegation.

The minimum execution spine is:

```
Thread / Message
 -> Intent Parse
 -> WorkOrder
 -> AuthorityDecision
 -> Run
 -> State Transition
 -> ToolInvocation or AgentDelegation when applicable
 -> ActionReceipt
 -> MemoryCandidate when applicable
 -> Response
```

### 3.1 Synchronous Orchestration Loop

The first runtime loop should be synchronous and deterministic.

A single request should be processed as a bounded chain of validated steps:

1. Receive input.
2. Validate input payload.
3. Resolve tenant, workspace, project, and actor context.
4. Persist thread/message records when applicable.
5. Parse or normalize intent.
6. Create a work order.
7. Classify authority.
8. Create or update a run record.
9. Execute allowed internal state transitions.
10. Invoke tools or delegate only when authorized.
11. Create append-only receipts.
12. Create memory candidates when warranted.
13. Return a response.

The synchronous loop does not mean every future operation must remain blocking. It means
the first implementation must prove deterministic lifecycle boundaries before asynchronous
workers are introduced.

### 3.2 Idempotency and Determinism Guarantees

CORE must be designed so meaningful runtime operations are safe to identify, inspect, retry,
and recover.

**No centralized mutation ledger.** CORE does not use a single global idempotency ledger
table. A global ledger becomes a serialization point that concurrent multi-agent runs would
contend on, undermining the modular-monolith goal of keeping mutation paths local and
inspectable. Instead, idempotency is enforced locally, per table, through a unique constraint:

```sql
UNIQUE (tenant_id, idempotency_key)
```

**Not every table carries an idempotency key.** The key is required only on tables that gate
expensive re-execution or external side effects. Ground-zero guidance:

| Table               | Idempotency key required | Reason                                                                 |
|---------------------|---------------------------|-------------------------------------------------------------------------|
| `work_orders`        | Yes                       | Prevents duplicate intent-to-work conversion on retry                  |
| `runs`                | Yes                       | Prevents duplicate execution attempts for the same trigger              |
| `tool_invocations`    | Yes                       | Prevents duplicate external side effects                                |
| `agent_delegations`   | Yes                       | Prevents duplicate delegation of the same unit of work                 |
| `action_receipts`     | Yes                       | Prevents a deduped upstream retry from still writing a second receipt for the same event |
| `memory_candidates`   | No                        | Duplicate candidates are low-cost and resolved at human/system review, not at execution time |
| `threads` / `messages`| No (message may carry a source-correlation id, not a retry-idempotency key) | Conversational input is not itself a side-effecting retry target |

**Write pattern.** Idempotent writes must use insert-or-fetch, not insert-and-catch-error:

```sql
INSERT INTO work_orders (tenant_id, idempotency_key, ...)
VALUES ($1, $2, ...)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING *;
```

If the `INSERT ... RETURNING` yields no row, the runtime must follow up with a `SELECT` on
`(tenant_id, idempotency_key)` to fetch the existing record and resume the execution spine
from that durable boundary, rather than treating the conflict as a failure or silently
re-creating downstream records.

The idempotency key should be derived from stable runtime identifiers such as:

- tenant_id
- workspace_id
- project_id
- thread_id
- message_id
- work_order_id
- run_id
- actor_id
- operation_type
- target_id when applicable
- retry lineage or attempt number

Idempotency does not mean every operation is infinitely replayable. It means CORE should
avoid duplicate state mutations, duplicate receipts claiming the same action, duplicate external
side effects, and out-of-order transitions when an operation is retried.

Retries must resume from the last durable boundary rather than blindly replaying the entire
model output.

Durable boundaries include:

- persisted Message
- persisted WorkOrder
- persisted AuthorityDecision
- persisted Run
- persisted ToolInvocation
- persisted AgentDelegation
- persisted ActionReceipt
- persisted MemoryCandidate

### 3.3 State Mutation Lifecycle

A state mutation is any meaningful change to CORE durable state.

State mutations should follow this lifecycle:

1. Validate the requested mutation against runtime schemas.
2. Resolve tenant/workspace/project/actor context.
3. Acquire any required Redis mutation lock.
4. Begin a tenant-scoped database transaction.
5. Re-read the current durable state inside the transaction.
6. Validate the transition from previous state to next state.
7. Apply the mutation with parameterized SQL, using the insert-or-fetch idempotency pattern
   from 3.2 where the target table carries an idempotency key.
8. Write required receipt/audit records.
9. Commit the transaction.
10. Release the lock.
11. Return the normalized result.

A mutation must not be considered complete until the durable state and required receipts are
committed.

### 3.4 Retry and Resume Semantics

A failed operation must be classified as retryable or non-retryable.

Retryable failures may include:

- transient database connection failure before commit
- lock contention
- temporary process execution failure
- timeout before external side effects
- recoverable validation failure after correction

Non-retryable failures may include:

- invalid state transition
- failed authority classification
- tenant boundary violation
- schema violation with no repair path
- unauthorized external side effect
- missing required capability

Resume behavior should begin from the last known durable state, located via the
`(tenant_id, idempotency_key)` lookup described in 3.2. The runtime should not rely on
conversational memory alone to determine where to resume.

## 4. Runtime Object Model

Runtime objects are the named primitives that CORE persists, validates, transitions, or returns.

These objects should be represented through explicit schemas and, when persistent, explicit
database tables or durable records.

### 4.1 Actor

An Actor is any entity that initiates, interprets, executes, delegates, or records work.

Actors may include:

- human users
- ELORA
- Nexora
- future specialist agents
- system processes
- tool runtimes

An actor record or actor reference should identify:

- actor identity
- actor type
- tenant scope
- workspace/project scope when applicable
- authority context
- runtime role

### 4.2 Thread

A Thread is a durable conversation or work context.

CORE owns the persistence primitive for threads. ELORA may own executive interpretation,
routing, summarization, and conversational behavior within threads.

A thread may contain many messages and may produce many work orders.

Thread records should support:

- tenant scope
- workspace/project scope
- thread title or summary
- status
- originating surface
- created/updated timestamps
- optional parent thread relationship

**Migration placement:** `Thread` is included in the first database migration alongside
`Message` (see 4.3), rather than staged later. ELORA's entry point into CORE depends on
`Thread`/`Message` existing before `WorkOrder` creation can be exercised end-to-end; staging
them separately would force stub validation paths that would need to be unwound once ELORA
ingestion is implemented.

### 4.3 Message

A Message is a durable input, response, or system communication inside a thread.

CORE owns the persistence primitive for messages. ELORA may interpret message content and
decide whether to create a work order.

Message records should support:

- thread reference
- actor reference
- message role
- content payload
- structured metadata
- created timestamp
- source surface
- optional correlation id (see note below — this is a correlation id, not a retry-idempotency
  key; see 3.2 table)

Messages are not the same as work orders. A message may lead to zero, one, or many work
orders.

**Append-only, supersession-based correction.** `Message` follows the same immutability
posture as `ActionReceipt` (8.1): a persisted message is never edited or deleted in place. If a
message must be corrected, retracted, or amended — whether by user edit or system
correction — the runtime creates a new message row that references the original through a
`supersedes_message_id` field, and the original row is left intact. This keeps `Thread` history
fully replayable and keeps the correction model consistent across every append-only object in
CORE, rather than leaving `Message` as an unstated exception.

**Migration placement:** see 4.2 — `Message` ships in the first migration.

### 4.4 WorkOrder

A WorkOrder is a structured unit of intended work.

A work order converts human/system intent into a durable object with scope, lifecycle, and
authority context.

A work order should include:

- tenant/workspace/project scope
- originating thread/message when applicable
- requested actor or owner
- interpreted intent
- task type
- status
- risk/authority classification reference
- created timestamp
- updated timestamp
- idempotency key (required — see 3.2 table)

Work orders are the primary unit of execution coordination.

### 4.5 Run

A Run is an execution attempt or execution frame associated with a work order.

A work order may have multiple runs over time.

A run should include:

- work order reference
- actor reference
- status
- start timestamp
- end timestamp
- attempt number
- failure classification when applicable
- retry/resume lineage
- execution metadata
- idempotency key (required — see 3.2 table)

Runs should make execution inspectable and replayable where practical.

### 4.6 AuthorityDecision

An AuthorityDecision records whether and how a work order, run, tool invocation, or
delegation is allowed to proceed.

Supported outcomes are:

- act
- act_and_report
- escalate
- setup_required
- capability_missing
- refuse

An authority decision should include:

- decision outcome
- reason
- risk level
- actor making or requesting the decision
- affected work order/run/tool/delegation
- required approval or setup when applicable
- timestamp

Authority is not a bypass. Authorization is a recorded state transition that still requires
bounded execution, validation, and receipts.

### 4.7 ActionReceipt

An ActionReceipt is an immutable append-only audit record for a meaningful action.

Receipts should capture what happened, why it happened, which actor/system performed it,
what authority allowed it, what state changed, and what follow-up may be required.

A receipt should eventually include the shared base fields defined in 8.2, plus type-specific
fields carried in a `payload` field per the JSONB boundary in 6.5:

- schema_version (per receipt_type — see 8.2)
- receipt_type
- tenant_id
- workspace_id / project_id when applicable
- work_order_id when applicable
- run_id when applicable
- actor_id
- acting_system
- authority decision reference
- tool invocation or delegation reference when applicable
- original request reference
- interpreted intent
- inputs accessed
- actions taken
- outputs produced
- files changed
- errors
- rollback hints
- memory candidate references
- parent/supersedes/correction receipt references
- created timestamp
- idempotency key (required — see 3.2 table)

Receipts are never mutated in place.

### 4.8 MemoryCandidate

A MemoryCandidate is a proposed durable memory record.

Receipts, messages, work orders, or agent outputs may create memory candidates, but memory
candidates are not automatically durable memory.

A memory candidate should include:

- source reference
- candidate content
- candidate type
- confidence
- scope
- review status
- reason for creation
- created timestamp
- promotion/supersession lineage when applicable

No idempotency key is required (see 3.2 table) — duplicate candidates are inexpensive and are
resolved during review rather than at execution time.

### 4.9 MemoryRecord

A MemoryRecord is durable memory that has been accepted, promoted, consolidated, or
otherwise approved according to the memory review path.

Ground zero may model memory records before implementing advanced retrieval.

Memory records should be structured enough to support future embeddings and vector
retrieval, but embedding generation and retrieval ranking are not ground-zero defaults.

### 4.10 ToolInvocation

A ToolInvocation is a governed attempt to use a tool or capability.

A tool invocation should include:

- tool identifier
- tool version when applicable
- input schema version
- validated input payload
- authority decision reference
- run reference
- status
- normalized output
- error payload when applicable
- receipt reference
- timestamps
- idempotency key (required — see 3.2 table)

Tools must be governed, scoped, logged, and validated.

### 4.11 AgentDelegation

An AgentDelegation records a parent actor delegating work to a child actor.

The runtime defines the generic delegation contract. ELORA.md and NEXORA.md define
participant-specific behavior later.

A delegation should include:

- parent actor
- child actor
- delegated work order
- inherited context references
- authority scope
- status
- yield/resume state
- return receipt
- completion status
- idempotency key (required — see 3.2 table)

### 4.12 ArtifactRecord

An ArtifactRecord represents a durable or semi-durable output produced by the runtime, a
tool, or an agent.

Examples include:

- generated document
- code patch
- test report
- architecture diagram
- receipt bundle
- export file

Artifact records should reference the work order, run, actor, and receipt that produced them.

## 5. State Classification Model

CORE separates runtime state into explicit categories so implementation does not blur code
definitions, transient execution state, durable state, and derived projections.

### 5.1 Static Engine Definitions

Static engine definitions live in code.

Examples include:

- Zod schemas
- enum definitions
- allowed state transitions
- authority outcome definitions
- receipt type definitions
- tool input/output schemas
- policy definitions
- migration definitions

Static engine definitions must be versioned through the repository and aligned with database
migrations.

### 5.2 In-Flight Ephemeral State

In-flight ephemeral state exists only during execution.

Examples include:

- Redis locks
- process-local execution frames
- pending subprocess state
- active transaction state
- temporary workspace paths
- timeout handles
- retry guards

Ephemeral state must not become the durable source of truth.

If a state must survive restart, support audit, support replay, or support review, it belongs in
PostgreSQL.

### 5.3 Persistent Relational State

Persistent relational state is durable CORE state stored in PostgreSQL.

Examples include:

- tenants
- workspaces
- projects
- actors
- threads
- messages
- work orders
- runs
- authority decisions
- receipts
- memory candidates
- memory records
- tool invocations
- agent delegations
- artifact records

Persistent state must be tenant-scoped where appropriate and protected through database-level
boundaries.

### 5.4 Derived / Reconstructable State

Derived state is generated from persistent state and can be reconstructed.

Examples include:

- UI summaries
- dashboard counts
- cached projections
- recent activity views
- computed thread summaries
- report previews

Derived state may be cached, but cached derived state must not become the source of truth.

### 5.5 State Ownership Rules

State ownership rules:

- PostgreSQL owns durable runtime truth.
- Redis owns only short-lived locks and ephemeral coordination.
- TypeScript owns state validation, mutation orchestration, and persistence logic.
- Python owns bounded workspace execution only.
- Agents operate through CORE state contracts.
- UI surfaces display or request state; they do not own runtime truth.

## 6. Relational Persistence Model

The relational persistence model defines how CORE stores durable runtime state.

### 6.1 Database Schema Paradigms

CORE should use explicit relational tables for core runtime objects.

Database design should favor:

- explicit primary keys
- tenant-scoped foreign keys
- clear status columns
- timestamp columns
- append-only audit tables where appropriate
- JSONB only for structured metadata that does not deserve first-class columns yet
- migration-controlled schema changes

Tables should be readable and directly inspectable without an ORM abstraction layer.

### 6.2 Zero-ORM Contract

Ground-zero CORE uses raw parameterized SQL through node-postgres (pg).

Heavy ORMs such as Prisma, Drizzle, TypeORM, Sequelize, or similar abstraction layers are not
part of the ground-zero architecture.

The zero-ORM contract exists because CORE requires:

- explicit transaction handling
- tenant context control
- PostgreSQL RLS alignment
- predictable query behavior
- inspectable SQL
- careful mutation sequencing

Small local query helpers are allowed when they preserve explicit SQL and transaction
boundaries, including the insert-or-fetch idempotency pattern in 3.2.

### 6.3 Scalar Relational Records

Scalar relational records are normal structured database rows.

Examples include:

- work_orders
- runs
- authority_decisions
- action_receipts
- tool_invocations
- agent_delegations

These records should use explicit columns for stable fields such as identifiers, statuses,
timestamps, actor references, and scope references — plus a `UNIQUE (tenant_id,
idempotency_key)` constraint on the tables identified in 3.2.

### 6.4 Vector-Ready Memory Records

Memory records may be designed to support future embeddings and vector retrieval.

Ground-zero may include schema affordances for pgvector compatibility, but embedding
generation, vector search behavior, retrieval ranking, and RAG pipelines are not active
implementation scope unless explicitly prompted.

The rule is:

```
pgvector-ready: yes
embedding pipeline: deferred
vector search behavior: deferred
external embedding calls: out of scope for ground zero
```

### 6.5 JSONB Metadata Boundaries

JSONB may be used for flexible metadata, tool outputs, model outputs, or evolving payloads.

JSONB must not become a dumping ground for important state that should be first-class
relational structure.

A field should become a typed column when it is:

- required for state transitions
- required for authority decisions
- required for tenant isolation
- frequently queried
- required for joins
- required for audit or replay
- part of a stable domain primitive

Receipt-specific fields that vary by `receipt_type` belong in a variant-specific `payload` JSONB
field rather than in the shared receipt base schema — see 8.2.

### 6.6 Migration and Schema Alignment

Database migrations and TypeScript/Zod schemas must stay aligned.

When a migration adds or changes a runtime object, the corresponding schema definitions and
tests should be updated in the same implementation slice when practical.

Migration rules:

- migrations should be deterministic
- migrations should be versioned
- migrations should not silently destroy data
- tenant-scoped tables should include tenant ownership where applicable
- RLS policies should be introduced with tenant-scoped tables
- indexes should support expected state lookups, including the
  `(tenant_id, idempotency_key)` unique index on tables identified in 3.2
- the first migration includes `threads` and `messages` alongside `work_orders`, `runs`,
  `authority_decisions`, `tool_invocations`, `action_receipts`, and `memory_candidates`
  (see 4.2 / 4.3)

## 7. Authority Model

The authority model determines whether and how a runtime action may proceed.

Authority is risk-based, not approval-first.

### 7.1 Authority Outcomes

Supported authority outcomes are:

- act
- act_and_report
- escalate
- setup_required
- capability_missing
- refuse

These outcomes should remain stable unless a future ADR expands them.

### 7.2 Risk Classification Inputs

Authority classification may consider:

- requested action type
- actor requesting the action
- target resource
- tenant/workspace/project scope
- reversibility
- external side effects
- financial/legal/security impact
- data sensitivity
- tool permissions
- prior authorization
- user preferences
- system capability availability

### 7.3 Approval vs Authorization

User approval is not a bypass.

Approval is one possible authority input that may permit a recorded state transition.

Authorized execution still requires:

- bounded scope
- validation
- state transition checks
- receipt creation
- error handling
- rollback or recovery hints where applicable

### 7.4 External Side Effect Boundary

External side effects require authority classification before execution.

Examples include:

- sending an email
- modifying a calendar event
- writing to a connected external service
- committing code
- creating or deleting files outside a bounded workspace
- spending money
- changing credentials or permissions

The runtime must not execute external side effects simply because an agent proposed them.

### 7.5 Authority Records

Authority decisions should be persisted when they affect a meaningful action, work order, tool
invocation, or delegation.

Authority records should include:

- outcome
- reason
- risk level
- deciding actor/system
- affected object
- timestamp
- required setup or escalation path when applicable

## 8. Receipt Model

Receipts are immutable audit records for meaningful runtime actions.

### 8.1 Append-Only Receipt Contract

Receipts and audit records are append-only.

Historical receipts must not be mutated in place.

If a correction, reversal, or supersession is required, the runtime must create a new record that
references the prior record.

`Message` follows the same append-only, supersession-based contract — see 4.3.

### 8.2 Receipt Versioning — Shared Base Archetype

All receipt variants share a single Zod base schema, implemented as a discriminated union on
`receipt_type`:

```ts
const ReceiptBase = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  schema_version: z.number().int(),
  receipt_type: z.string(),
  actor_id: z.string(),
  acting_system: z.string(),
  created_at: z.string().datetime(),
  parent_receipt_id: z.string().uuid().nullable(),
  supersedes_receipt_id: z.string().uuid().nullable(),
  correction_receipt_id: z.string().uuid().nullable(),
});

const ActionReceipt = z.discriminatedUnion("receipt_type", [
  ToolInvokedReceipt,      // ReceiptBase.extend({ receipt_type: z.literal("tool_invoked"), payload: ToolInvokedPayload })
  WorkOrderCreatedReceipt, // ReceiptBase.extend({ receipt_type: z.literal("work_order_created"), payload: WorkOrderCreatedPayload })
  // ...additional receipt_type variants
]);
```

**Base field discipline.** The base schema holds only fields that are genuinely universal across
every receipt type and strictly typed: `id`, `tenant_id`, `schema_version`, `receipt_type`,
`actor_id`, `acting_system`, `created_at`, and the correction-lineage fields. Anything specific to
a given `receipt_type` (tool output shape, delegation return shape, work-order snapshot, etc.)
belongs in that variant's `payload` field per the JSONB boundary in 6.5. Type-specific fields
must not bleed into the shared base — doing so defeats the purpose of having a JSONB boundary
at all.

**Per-type schema_version.** `schema_version` versions independently per `receipt_type`, not
globally across all receipts. A global version counter would force every receipt type to bump in
lockstep whenever any single type's payload shape changes, producing version numbers that
carry no meaningful signal when inspecting one type's history in isolation. Each `receipt_type`
maintains its own version lineage starting at `1`.

This shared-base, discriminated-union approach guarantees that log collectors and append-only
verification logic can process `id`, `tenant_id`, `schema_version`, `receipt_type`, `created_at`,
and the correction-lineage fields identically across every receipt type, without needing to know
the variant-specific payload shape.

### 8.3 Receipt Types

Potential receipt types include:

- work_order_created
- authority_decided
- state_transitioned
- tool_invoked
- agent_delegated
- artifact_created
- memory_candidate_created
- run_failed
- run_completed
- receipt_corrected
- receipt_superseded

Receipt types should be explicit and stable.

### 8.4 Correction / Supersession Model

Receipts may reference prior receipts through fields defined on the shared base (8.2):

- parent_receipt_id
- supersedes_receipt_id
- correction_receipt_id

Corrections do not erase the historical record. They add a new record that clarifies or
supersedes the prior record.

### 8.5 Receipt-to-Memory Candidate Flow

A receipt may create a memory candidate when an action reveals information that may be
useful later.

Receipts are not memory.

Receipts are audit records. Memory candidates are proposed durable context.

## 9. Memory Candidate Model

The memory candidate model governs how working context may become durable memory.

### 9.1 Working Context vs Durable Memory

Working context is temporary context used during a thread, run, or execution.

Durable memory is persistent user/project/system knowledge that should be available later.

CORE must not blindly convert working context into durable memory.

### 9.2 Candidate Creation

Memory candidates may be created from:

- messages
- receipts
- work order outcomes
- user corrections
- repeated preferences
- project decisions
- system observations
- explicit memory requests

A candidate should include enough context for later review.

### 9.3 Candidate Review States

Potential candidate states include:

- proposed
- needs_review
- approved
- rejected
- consolidated
- superseded
- promoted

Ground-zero does not need to implement every state immediately, but the model should leave
room for review and promotion.

### 9.4 Promotion to MemoryRecord

A memory candidate becomes a memory record only after it passes the appropriate review or
promotion path.

Promotion should preserve source references so memory can be traced back to its origin.

### 9.5 pgvector Embedding Boundary

pgvector support is a future-ready memory capability.

Ground-zero may prepare schema boundaries for embeddings, but embedding generation and
vector retrieval are deferred unless explicitly scoped.

External embedding provider calls are out of scope for ground zero.

## 10. Tool Invocation Model

Tools are governed capabilities available to the runtime.

A tool may be internal, local, external, or connector-based. Regardless of source, tool use must
pass through CORE validation, authority, and receipt boundaries.

### 10.1 Tool Registry Boundary

The tool registry defines what tools exist, what they can do, what schemas they require, and
what authority level they need.

Ground-zero may model the tool invocation object before implementing a full registry.

### 10.2 Schema Validation

Tool inputs and outputs must be validated through schemas.

The runtime must not rely on model-generated arguments without validation.

### 10.3 Pre-Flight Checks

Before invocation, the runtime should check:

- tool availability
- required configuration
- input schema validity
- authority classification
- tenant/workspace/project scope
- rate or lock constraints when applicable
- capability boundaries

### 10.4 Authority Checkpoint

Tool invocation must pass through authority classification before external side effects.

A tool may be allowed for read-only use but require escalation for write actions.

### 10.5 Execution Routing

Execution routing determines whether a tool is handled by:

- internal TypeScript module
- bounded Python workspace runner
- external connector
- future MCP-compatible adapter
- future worker/service

Ground zero should prefer simple local routing.

### 10.6 Tool Result Normalization

Tool results should be normalized before being persisted or returned.

Normalized tool results should include:

- status
- structured output
- error payload when applicable
- duration
- files changed when applicable
- stdout/stderr when applicable
- external identifiers when applicable

### 10.7 Tool Invocation Receipts

Meaningful tool invocations must produce receipts.

Receipts should identify:

- tool used
- actor/system invoking it
- authority decision
- validated input summary
- output summary
- errors
- state changes
- artifact references

## 11. Agent Delegation Model

Agent delegation allows one actor to assign work to another actor through CORE state.

The runtime defines generic delegation mechanics. ELORA.md and NEXORA.md define specific
participant behavior.

### 11.1 Parent-to-Child Delegation

A parent actor may delegate a work order or sub-work order to a child actor.

Delegation must be recorded. Agents do not hand work to each other through hidden prompt
state.

### 11.2 Context Inheritance

A delegation may include inherited context references.

Inherited context should be reference-based where possible rather than copied blindly.

Examples:

- thread reference
- message reference
- work order reference
- artifact reference
- memory candidate reference
- receipt reference
- authority scope

### 11.3 WorkOrder Delegation

Delegated work should be represented as a work order or sub-work order.

Delegation should preserve:

- parent work order
- child work order
- parent actor
- child actor
- scope boundaries
- expected return path
- authority limits

### 11.4 Yield / Resume States

Agents may need to yield work when blocked.

Example yield reasons:

- awaiting authority
- awaiting setup
- missing capability
- tool failure
- validation failure
- user clarification needed
- dependency not ready

Resume must use durable state, not hidden agent memory.

### 11.5 Specialized Delegation Profiles

ELORA-to-Nexora delegation is expected to be the first specialized delegation profile, but the
specific ELORA and Nexora responsibilities are defined in ELORA.md and NEXORA.md.

The CORE runtime only defines generic delegation mechanics:

- parent actor
- child actor
- delegated work order
- inherited context references
- authority scope
- yield/resume state
- return receipt
- completion status

## 12. Tenant and Workspace Boundaries

CORE must maintain strict logical isolation across tenants, workspaces, projects, and users.

### 12.1 Tenant Boundary

A tenant is the highest-level logical ownership boundary.

Tenant-scoped records must include tenant ownership where applicable.

Tenant isolation must be enforced at the database boundary, not only in application logic.

### 12.2 Workspace Boundary

A workspace is an operational context within a tenant.

A workspace may represent a repo, business unit, project area, product surface, or managed
environment.

### 12.3 Project Boundary

A project is a scoped body of work within a tenant or workspace.

Project boundaries help constrain work orders, memory, artifacts, and tool access.

### 12.4 User Boundary

A user boundary distinguishes human participants and their permissions.

User context should be preserved in state transitions, authority decisions, receipts, and
messages.

### 12.5 Cross-Boundary Failure Rules

If runtime execution detects tenant/workspace/project/user boundary ambiguity, it must fail
clearly.

The runtime must not guess across boundaries to make an operation succeed.

## 13. TypeScript / Python Boundary

The TypeScript runtime owns CORE state. Python owns bounded workspace execution.

### 13.1 Ownership Split

TypeScript owns:

- schemas
- state machine
- database access
- authority
- receipts
- work orders
- tool routing
- persistence

Python owns:

- bounded workspace execution
- patch validation
- subprocess execution
- lint/typecheck/test invocation
- AST/code inspection utilities when needed

Python must not connect directly to the primary database pool.

### 13.2 Process Boundary

Ground zero should use a simple process boundary.

The TypeScript runtime may spawn bounded Python processes or call bounded local scripts.

Persistent IPC, sockets, gRPC, and long-running Python services are deferred unless ratified by
a future ADR.

### 13.3 Data Serialization Contract

Data crossing the TypeScript/Python boundary must be serialized and validated.

The TypeScript runtime should validate outbound payloads before execution and validate
inbound payloads after Python returns.

Python return payloads should be structured and machine-readable.

### 13.4 Workspace Isolation

Python routines must operate inside configured workspace boundaries.

They must not receive unrestricted filesystem, shell, network, credential, or production access.

### 13.5 Python Return Payloads

Python return payloads should include:

- status
- stdout
- stderr
- exit code
- duration
- changed files
- produced artifacts
- error type
- error message
- cleanup status

### 13.6 Future IPC Options

Future IPC options may include persistent workers, socket protocols, gRPC, or service
boundaries.

These are deferred and must not be introduced by default.

## 14. Database Boundary

The database boundary is one of the most important safety surfaces in CORE.

### 14.1 Parameterized SQL Enforcement

All database queries must use parameterized SQL.

Raw user input must never be concatenated into SQL strings.

### 14.2 Deterministic Pool Client Checkout Sequence

Tenant-scoped database mutation must follow this sequence:

1. Checkout isolated pool client.
2. BEGIN transaction.
3. Set tenant context with `SELECT set_config('vireon.current_tenant_id', $1, true)`.
4. Execute parameterized queries, using the insert-or-fetch idempotency pattern from 3.2 on
   tables that carry an idempotency key.
5. Insert or update required run/audit/receipt records.
6. COMMIT on success.
7. ROLLBACK on failure.
8. Release client in finally.

No tenant-scoped query may run outside this sequence.

### 14.3 Transaction-Scoped RLS Configuration

Tenant context must be transaction-scoped.

Required format:

```sql
SELECT set_config('vireon.current_tenant_id', $1, true)
```

The third argument must be `true` so tenant context is local to the transaction.

### 14.4 Commit / Rollback Rules

A transaction must commit only after all required state mutations and receipt records succeed.

A transaction must roll back when required validation, authority, state transition, receipt, or
database operations fail.

### 14.5 Row Locking and Mutation Safety

State transitions should use row-level locking where practical.

For example, a work order transition should re-read the current work order inside the
transaction and lock the row before applying the transition.

The runtime must not assume stale in-memory state is still valid.

### 14.6 Query Helper Requirements

Query helpers are allowed only if they preserve:

- explicit SQL
- parameterized queries
- isolated client usage
- transaction boundaries
- tenant context setup
- rollback/release safety

Helpers must not hide unsafe behavior. This includes the insert-or-fetch idempotency helper
from 3.2, which must remain explicit SQL rather than a hidden abstraction.

## 15. Redis Boundary

Redis is an ephemeral coordination layer.

Redis is not durable CORE state.

### 15.1 Mutation Locks

Redis may be used for short-lived mutation locks.

Locks can help prevent duplicate concurrent state mutation attempts for the same work order,
run, tool invocation, or artifact.

### 15.2 Lock Token Safety

Redis locks should use unique lock tokens.

A lock release operation should only release the lock when the token matches the owner.

### 15.3 TTL Requirements

Locks must have TTLs.

A lock without a TTL can deadlock the runtime after a crash or timeout.

### 15.4 Ephemeral Coordination Only

Redis may support:

- short-lived locks
- cache
- ephemeral coordination
- rate guards

Redis must not store durable work order state, receipts, memory, or authority decisions.

### 15.5 Redis Is Not Durable State

Any data that must survive restart, support audit, support replay, or support review belongs in
PostgreSQL.

## 16. Error and Failure Model

CORE must fail clearly and preserve enough state to debug and recover.

### 16.1 Typed Failure Paths

Important failures should have explicit error types or clearly named error objects.

Examples:

- ValidationError
- AuthorityError
- TenantBoundaryError
- StateTransitionError
- ReceiptWriteError
- ToolInvocationError
- SandboxExecutionError
- DatabaseTransactionError

### 16.2 Panic Criteria

The runtime should stop execution immediately when it detects:

- tenant boundary violation
- receipt immutability violation
- invalid state transition
- unauthorized external side effect
- database transaction safety failure
- schema validation failure at a critical boundary
- suspected secret exposure

### 16.3 Transaction Rollback Rules

Any required operation failure inside a transaction should trigger rollback.

The runtime must not partially commit a meaningful action without the required receipt or
audit state.

### 16.4 Tool Failure Handling

Tool failures should be normalized and recorded.

A failed tool invocation may still produce a receipt if the attempt itself was meaningful and
should be auditable.

### 16.5 Retryable vs Non-Retryable Failures

Failures should be classified when possible.

Retryable failures should preserve retry lineage.

Non-retryable failures should provide a clear reason and, when helpful, a recommended next
action.

### 16.6 Failed Run Receipts

Failed runs should create receipts when the failure is meaningful.

A failed run receipt should include:

- work order reference
- run reference
- actor/system
- failure type
- failure message
- state at failure
- rollback status
- retry recommendation

## 17. Verification Expectations

Every implementation slice should include verification appropriate to the changed runtime
surface.

### 17.1 Zod Validation Tests

Schema tests should verify valid and invalid payloads, including that the receipt discriminated
union (8.2) rejects payloads with a mismatched `receipt_type`/`payload` pairing.

### 17.2 State Transition Tests

State machine tests should verify valid and invalid transitions.

### 17.3 Tenant Boundary Tests

Database tests should verify tenant-scoped behavior where practical.

### 17.4 Receipt Immutability Tests

Receipt tests should verify append-only behavior and correction/supersession behavior when
implemented, including for `Message` (see 4.3).

### 17.5 Tool Invocation Tests

Tool tests should verify input validation, authority checkpoints, result normalization, and
failure handling.

### 17.6 Idempotency Tests

Idempotency tests should verify that:

- a retried write against a table with an idempotency key does not create a duplicate row
- the insert-or-fetch pattern (3.2) correctly returns the existing durable record on conflict
- retries resume the execution spine from the last durable boundary rather than re-running
  prior steps
- no duplicate receipts, duplicate external side effects, or out-of-order state transitions occur

Ground-zero tests may start small but should establish this pattern early.

## 18. Out-of-Scope for Ground Zero

The following are out of scope for ground zero unless explicitly scoped by an active
implementation prompt or ratified by a future ADR:

- production cloud deployment
- distributed microservices
- Go/gRPC orchestration
- Kubernetes
- external model-provider calls
- Google Workspace integrations
- unrestricted shell execution
- autonomous production actions
- advanced agent society behavior
- full UI product surface
- large-scale multi-tenant SaaS operations
- LangGraph
- LlamaIndex
- MCP servers
- OpenTelemetry
- Redis Streams
- NATS
- Temporal
- Firecracker/gVisor/Kata sandboxing
- embedding generation
- vector retrieval ranking
- mature RAG pipelines
- a centralized mutation/idempotency ledger table (see 3.2 — rejected, not merely deferred)

These may be valid future technologies or product surfaces, but they are not ground-zero
implementation defaults.

## 19. Relationship to Other Docs

This document sits below ADR 0001 and above ELORA/NEXORA runtime-specific documents.

```
README.md
 -> AGENTS.md
 -> ADR 0001: Ground-Zero Architecture
 -> docs/architecture/core-runtime.md
 -> ELORA.md / NEXORA.md
 -> implementation prompts
```

### 19.1 README.md

README.md defines stable repo orientation.

It tells a reader what Vireon CORE is and how the repository is positioned.

README.md should not define active tasking or sprint status.

### 19.2 AGENTS.md

AGENTS.md defines operating rules for AI coding agents.

It tells Codex, Claude Code, Cursor, and other coding agents how to behave when modifying the
repository.

### 19.3 ADR 0001

ADR 0001 defines the accepted ground-zero architectural decision:

- local-first modular monolith
- TypeScript / Node.js deterministic runtime
- PostgreSQL 17 + pgvector
- Redis 7.4
- bounded Python workspace execution
- deferred distributed services and workflow engines

This document expands that decision into a runtime specification.

### 19.4 ELORA.md

ELORA.md should define ELORA as the executive ingestion and coordination runtime that
consumes CORE primitives.

ELORA should consume:

- Thread
- Message
- WorkOrder
- AuthorityDecision
- ActionReceipt
- MemoryCandidate
- AgentDelegation

ELORA should not redefine database boundaries, receipt immutability, tenant isolation, or
Python execution boundaries. Those are inherited from this document.

### 19.5 NEXORA.md

NEXORA.md should define Nexora as the engineering execution runtime that consumes CORE
primitives.

Nexora should consume:

- WorkOrder
- Run
- ToolInvocation
- AgentDelegation
- ActionReceipt
- ArtifactRecord
- MemoryCandidate

Nexora should not bypass work orders, authority decisions, receipts, sandbox rules, or
tenant/workspace boundaries.

## 20. Draft Resolution Notes

This document was revised from an initial rough draft. The following open questions raised in
the original draft have been resolved and folded into the sections above:

1. **Idempotency key placement (was open).** Resolved in 3.2: no centralized mutation ledger;
   local `UNIQUE (tenant_id, idempotency_key)` constraints per table, applied only to tables
   that gate expensive re-execution or external side effects (see the table in 3.2), using an
   insert-or-fetch write pattern rather than insert-and-catch-error.

2. **Thread/Message staging (was open).** Resolved in 4.2/4.3: both ship in the first
   migration, since ELORA's ingestion path depends on them existing before `WorkOrder`
   creation can be exercised end-to-end. `Message` additionally adopts the same append-only,
   supersession-based correction model as `ActionReceipt`.

3. **Receipt versioning as a shared base contract (was open).** Resolved in 8.2: all receipt
   variants extend a common Zod base via a discriminated union on `receipt_type`. The base
   holds only universal, strictly-typed fields; variant-specific fields live in a `payload` JSONB
   field per 6.5. `schema_version` versions independently per `receipt_type`, not globally.

Remaining open questions carried forward, not yet resolved:

- Whether `ToolInvocation` records should exist in schema before the tool registry (10.1) is
  implemented, or whether the registry should land first.
- Whether `AgentDelegation` should be scaffolded in schema before ELORA-to-Nexora execution
  (11.5) is implemented, or introduced alongside it.
- Whether `MemoryCandidate` review states (9.3) should be implemented in full at ground zero
  or trimmed to a minimal subset (e.g. `proposed` / `approved` / `rejected` only) for the first
  slice.

These remain open for the next planning pass and should not be inferred by an implementing
agent without explicit instruction.
