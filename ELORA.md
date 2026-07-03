ELORA.md
Executive Ingestion and Coordination Runtime

Document: /ELORA.md
Project: Vireon CORE
Status: Draft v2 (tactical refinements folded in — schema-locking pass for Phase 0)
Date: 2026-07-03

Runtime boundary document for ELORA as the executive ingestion and coordination layer of Vireon CORE.

## 1. Purpose

This document defines ELORA's runtime boundary inside Vireon CORE.

ELORA is the executive ingestion and coordination runtime for CORE. She receives human and system input,
interprets intent, preserves conversational continuity, creates or routes work orders, classifies authority
needs, surfaces memory candidates, delegates work to specialist actors, and synthesizes responses back to
the user.

This is not a persona-lore document. ELORA's voice, personality, mythic identity, and character material may
exist elsewhere, but this file defines the runtime contract that governs what ELORA owns, consumes, creates,
delegates, records, and must never bypass.

The purpose of this file is to prevent implementation drift by making ELORA explicit:

- what ELORA receives
- how ELORA resolves context
- how ELORA works with Thread and Message records
- how ELORA interprets intent
- when ELORA causes WorkOrder creation
- how ELORA interacts with authority decisions
- how ELORA synthesizes responses
- how ELORA proposes memory candidates
- when ELORA may use tools
- when ELORA delegates to another actor
- how ELORA handles failure
- what ELORA v1 should and should not attempt

ELORA inherits from the CORE runtime model. She does not redefine database boundaries, tenant isolation,
receipt immutability, Python execution rules, Redis behavior, or the generic delegation contract.

## 2. Runtime Role

ELORA is the executive layer positioned between the user-facing conversational surface and the lower CORE
execution spine.

At ground zero, ELORA is responsible for interpreting input and coordinating the next runtime action. She
should determine whether a message is casual conversation, a clarification, a task request, a memory-worthy
update, a question that can be answered directly, a work order candidate, a delegation candidate, or a
request that requires escalation or setup.

ELORA should not act as an unconstrained autonomous agent. She operates through CORE primitives and
must preserve the runtime's state-first doctrine.

ELORA's role can be summarized as:

```
User/System Input
 -> ELORA ingestion and interpretation
 -> CORE Thread/Message persistence
 -> Intent classification
 -> WorkOrder routing when warranted
 -> Authority classification
 -> Response, MemoryCandidate, ToolInvocation, or AgentDelegation
```

ELORA coordinates. CORE persists and enforces. Specialist agents execute within their own runtime
boundaries.

## 3. Relationship to CORE Runtime

ELORA consumes the primitives defined in /docs/architecture/core-runtime.md.

ELORA may consume or produce references to:

- Actor
- Thread
- Message
- WorkOrder
- AuthorityDecision
- ActionReceipt
- MemoryCandidate
- ToolInvocation
- AgentDelegation
- ArtifactRecord

ELORA should not redefine the following CORE runtime contracts:

- database transaction lifecycle
- tenant-scoped RLS configuration
- Redis lock behavior
- Python execution boundary
- receipt immutability
- message immutability
- generic AgentDelegation mechanics
- idempotency model for WorkOrder, Run, ToolInvocation, AgentDelegation, and ActionReceipt
- JSONB metadata boundaries
- pgvector future boundary

ELORA's job is to apply these primitives to executive ingestion and coordination.

## 4. ELORA as Actor

ELORA is a CORE Actor.

As an actor, ELORA must be identifiable in work orders, receipts, authority decisions, delegation records, and
memory candidate sources.

An ELORA actor reference should identify:

- actor_id
- actor_type: agent
- actor_name: ELORA
- actor_role: executive_ingestion_runtime
- tenant scope
- workspace/project scope when applicable
- runtime capabilities
- authority context
- acting_system identifier

ELORA may appear in records as:

- interpreting actor
- deciding actor
- delegating actor
- responding actor
- memory-candidate source actor
- coordination actor

ELORA should not appear as the actor that directly performed lower-level execution if another actor or tool
actually performed it. For example, if Nexora applies a patch, Nexora is the executing actor. ELORA may be
the delegating or synthesizing actor.

## 5. Inputs ELORA May Receive

ELORA may receive input from several runtime surfaces.

Ground-zero inputs may include:

- direct user text
- structured user commands
- system triggers
- implementation prompts
- thread continuation messages
- clarification responses
- explicit memory instructions
- future webhook or connector events

Every input must be normalized before ELORA interprets it.

A normalized ELORA ingress payload should include:

- tenant_id
- workspace_id when applicable
- project_id when applicable
- actor_id for the human or system source
- source surface
- thread_id when continuing a thread
- raw content
- optional structured metadata
- optional inbound correlation id
- received timestamp

Inputs may begin as text, JSON, or connector payloads, but they must become validated runtime payloads
before state mutation.

ELORA must not rely on unvalidated model output, user text, webhook payloads, or tool results as trusted
structure.

## 6. Context Resolution Boundary

Before ELORA can persist a message or interpret intent, the runtime must resolve context.

Context resolution maps an incoming payload to tenant, workspace, project, actor, and thread scope.

### 6.1 Tenant Resolution

Tenant resolution determines the highest-level ownership boundary for the input.

If tenant scope cannot be resolved, the runtime must not proceed with tenant-scoped persistence or
interpretation.

A tenant resolution failure may produce an ingestion-level failure receipt or operational error record, but it
must not guess across tenants.

### 6.2 Workspace / Project Resolution

Workspace and project resolution determine the operational context for the message or work order.

Workspace and project scope may be explicit, inferred from a thread, or provided by the active user prompt.

If scope is ambiguous, ELORA should ask for clarification rather than route work into the wrong workspace.

### 6.3 Actor Resolution

Actor resolution identifies who or what submitted the input.

The source actor may be a human user, system process, webhook, scheduled trigger, or future agent.

Actor identity should be preserved in Message, WorkOrder, AuthorityDecision, ActionReceipt, and
MemoryCandidate records.

### 6.4 Ambiguity Failure Rules

If context resolution cannot determine the correct tenant, workspace, project, actor, or thread, ELORA must
fail clearly.

The runtime must not guess across boundaries to make an operation succeed.

Ambiguity should lead to one of the following:

- clarification request
- setup_required outcome
- context_resolution_failed receipt or failure record
- safe refusal when the requested action cannot be scoped

## 7. Thread and Message Responsibilities

CORE owns durable Thread and Message persistence. ELORA owns interpretation, summarization, routing,
and response behavior within those records.

The split is:

CORE owns durable Thread and Message records.
ELORA owns executive interpretation of Thread and Message content.

### 7.1 Ingestion and Mutation Contracts

A user or system input should become a durable Message after ingress validation and context resolution.

Message persistence should not depend on downstream intent parsing, WorkOrder creation, authority
classification, or delegation success.

Messages are append-only facts of input. WorkOrders are structured interpretations of intent.

A failed interpretation must not erase or prevent the original message from being recorded.

### 7.2 Inbound Correlation and Duplicate Submission Handling

Inbound correlation protects against duplicate message submission caused by flaky clients, refreshes,
network retries, or webhook redelivery.

Inbound correlation is not the same as internal retry idempotency for WorkOrders, Runs, ToolInvocations,
AgentDelegations, or Receipts.

A Message may carry a source correlation id. If a client submits the same correlation id for the same
tenant/thread/source boundary, the runtime may fetch the existing Message rather than creating a duplicate.

The inbound correlation model should not erase legitimate repeated user messages. If the user intentionally
sends the same text twice without the same correlation id, the runtime should treat them as separate
messages.

### 7.3 Thread Summarization and Pruning Protocols

ELORA may summarize thread context for response synthesis or later retrieval.

Thread summaries are derived state. They do not replace the append-only Message record.

Pruning should affect context-window construction, not durable history.

A summary should preserve references to source messages when practical.

### 7.4 Context Windows and Token Budget Limits

ELORA may construct context windows from messages, summaries, memory records, receipts, artifacts, and
active work orders.

Context-window construction must be bounded.

ELORA should prefer explicit references and summaries over blindly loading entire thread histories.

Token budget pressure should lead to summarization, clarification, or bounded retrieval - not hidden loss of
important state.

## 8. Intent Interpretation Model

Intent interpretation converts a Message into a structured understanding of what should happen next.

ELORA may classify a message as one or more of the following:

- chat_response
- direct_answer
- clarification_response
- work_order_candidate
- memory_candidate_source
- tool_use_candidate
- delegation_candidate
- escalation_candidate
- setup_required
- capability_missing
- refusal_required

LLM classification output must be validated through deterministic schemas before it is trusted by the
runtime.

A validated intent interpretation should include:

- source message reference
- interpreted intent
- confidence
- task type when applicable
- proposed scope
- ambiguity flags
- authority hints
- memory candidate hints
- delegation hints
- clarification question when needed

Intent interpretation is not execution. It is a structured intermediate step that may lead to a WorkOrder,
response, clarification, memory candidate, or refusal.

## 9. WorkOrder Creation Boundary

ELORA may cause or recommend WorkOrder creation when a message expresses actionable intent.

A WorkOrder must not be created through hidden prompt state. It must be persisted through CORE runtime
contracts.

### 9.1 Durable Message First, WorkOrder Second

Message persistence and WorkOrder creation should be separate lifecycle boundaries.

Correct ordering:

```
Ingress payload received
 -> resolve tenant/workspace/project/actor context
 -> persist Thread/Message
 -> commit Message transaction
 -> parse intent
 -> if task-worthy, create WorkOrder in a separate transaction
 -> if parse fails, throw IntentParseFailed and emit a standalone intent_parse_failed receipt
 -> return clarification/failure response
```

**Second-transaction failure handling.** If the WorkOrder-creation transaction fails, times out, or the intent
parse step it depends on fails for any reason, the runtime must not leave the operation in an ambiguous or
partially-committed state. The engine must:

1. Throw a strongly-typed error, `IntentParseFailed`, rather than allowing the failure to surface as a generic
   database or network exception.
2. Roll back the WorkOrder transaction cleanly — the already-committed Message transaction from the prior
   step is untouched and remains the durable record of what the user said.
3. Emit a standalone `intent_parse_failed` receipt (see 17.2) referencing the persisted `message_id`, so the
   failure itself is audit-visible even though no `WorkOrder` or `Run` was ever created.
4. Return a clarification or failure response to the user rather than retrying silently or leaving the request
   in an uncommitted `node-postgres` transaction state.

This closes two failure classes: the engine hanging on an open transaction, and the orchestration loop
swallowing the failure and reporting success or silence back to the user.

The WorkOrder idempotency key should be derived from stable runtime identifiers such as tenant_id,
thread_id, message_id, actor_id, task type, and interpreted intent fingerprint.

ELORA must not prevent Message persistence merely because WorkOrder creation fails.

> **Cross-document note:** `intent_parse_failed` is not currently listed among the `receipt_type` values in
> core-runtime.md §8.3. Since this receipt type is now a required part of the WorkOrder creation boundary,
> core-runtime.md §8.3 should be updated in the same implementation slice to include it — otherwise the
> receipt schema's discriminated union (core-runtime §8.2) will reject it at validation time.

### 9.2 Task Typing and Scope Classification

When creating or recommending a WorkOrder, ELORA should classify the work.

Potential task types include:

- answer_question
- draft_document
- summarize_context
- update_document
- inspect_repository
- propose_code_change
- execute_code_validation
- create_memory_candidate
- delegate_engineering_work
- request_clarification
- escalate_authority

Scope classification should identify:

- tenant
- workspace
- project
- thread
- source message
- intended owner
- affected resources
- expected output
- authority level
- whether delegation is likely

Task typing should remain explicit and stable enough for routing, testing, and later analytics.

## 10. Authority Classification Boundary

ELORA is authority-aware.

ELORA may recommend or request authority classification, but authority decisions must be persisted through
CORE runtime contracts when they affect meaningful work.

### 10.1 Risk Assessment Matrix

ELORA may evaluate risk using inputs such as:

- requested action type
- reversibility
- external side effects
- tool requirements
- affected data sensitivity
- tenant/workspace/project scope
- financial/legal/security impact
- user authorization context
- setup requirements
- capability availability

Supported authority outcomes are inherited from the CORE runtime:

- act
- act_and_report
- escalate
- setup_required
- capability_missing
- refuse

ELORA should preserve CORE's risk-based autonomy model. She should not default to approval-first
behavior, but she must not route external side effects without authority classification.

### 10.2 Authority Decision Write Pattern

Authority decisions that affect WorkOrders, ToolInvocations, AgentDelegations, or meaningful actions must
be written as durable records.

The authority write pattern should capture:

- schema_version
- requested action
- affected runtime object
- deciding actor/system
- outcome
- reason
- risk level
- **requires_human_gatekeeper** — an explicit boolean flag, set alongside `outcome`
- required setup or approval when applicable
- timestamp

**`requires_human_gatekeeper` ownership.** This flag must be set exclusively by CORE's deterministic
authority-classification code — the same code path that maps risk inputs (10.1) to a supported outcome. It
must never be set, overridden, or influenced directly by raw LLM output. The LLM may propose a risk
assessment or a recommended outcome as part of intent interpretation (§8), but that proposal is treated as
an *input* to the deterministic classifier, not as the classifier's decision. Concretely: the LLM's proposed
outcome and the LLM's proposed risk level are validated fields on the intent-interpretation record; the
authority decision record's `outcome` and `requires_human_gatekeeper` fields are independently computed
and written by deterministic code that consumes those proposals alongside the other risk-matrix inputs.

The purpose of this separation is to prevent an LLM-driven ingestion path from writing a spoofed `act` or
`act_and_report` outcome directly into PostgreSQL to bypass a higher permission boundary during a
downstream tool-invocation pre-flight check (see §13). If the LLM's output could set the flag directly, the
spoofing risk this field exists to close would simply move one layer up rather than being eliminated — the
deterministic-write requirement is what actually closes it.

This is distinct from tool pre-flight checks. Tool pre-flight checks occur later at the ToolInvocation boundary
(core-runtime §10.3) and re-validate authority rather than trusting this record blindly.

## 11. Response Synthesis Boundary

ELORA is the primary user-facing synthesis layer.

Response synthesis converts CORE state, interpretation results, receipts, tool outputs, delegation outcomes,
memory candidates, and failure states into a clear user-facing response.

ELORA may synthesize:

- direct answers
- clarification questions
- task status updates
- completion summaries
- refusal explanations
- setup-needed responses
- capability-missing responses
- delegation updates
- receipt summaries
- next-step recommendations

Response synthesis must not fabricate completed work.

If work was not executed, ELORA should say whether it was blocked by setup, capability, authority, missing
information, validation failure, or out-of-scope boundary.

When a response summarizes execution, it should be grounded in durable CORE state where possible.

## 12. Memory Candidate Boundary

ELORA may identify potential memory candidates from user messages, repeated preferences, project
decisions, corrections, outcomes, and receipts.

ELORA does not blindly write durable memory.

ELORA may propose MemoryCandidate records when context appears durable, useful, non-noisy, and
reviewable.

Memory candidates may include:

- user preference
- project decision
- recurring constraint
- identity or role detail
- named system concept
- architectural decision
- correction to prior understanding
- long-term workflow preference

A MemoryCandidate should include:

- source message or receipt reference
- candidate content
- reason for creation
- confidence
- scope
- review status
- created timestamp

Receipts are not memory. Messages are not automatically memory. Memory candidates are proposed
durable context.

## 13. Tool Use Boundary

ELORA may route tool use requests through CORE, but she does not bypass ToolInvocation, authority,
schema validation, or receipts.

At ground zero, ELORA may be permitted to use read-only or low-risk internal tools when explicitly scoped by
an implementation prompt.

**Read-only tool isolation.** Any read-only or low-risk tool made available to ELORA at ground zero must
execute through one of the following isolation mechanisms, not through the same connection/transaction
context used for state-mutating CORE operations:

- an isolated, explicitly read-only PostgreSQL transaction branch (e.g. `SET TRANSACTION READ ONLY`,
  or a pool client/role scoped to read-only grants), or
- a fully sandboxed context block with no live handle to a writable database connection at all.

This constraint exists specifically to bound the blast radius of a prompt-injection attack against ELORA's
ingestion loop (§5). Even if injected content in a message, document, or tool result manages to influence
what SQL-like intent a read-only tool call carries, the isolation boundary — not the tool's own logic — is
what prevents that call from writing, altering, or reading across tenant boundaries. The read-only guarantee
must be enforced at the connection/transaction level, not merely assumed from the tool's intended purpose.

Mutating tools, external side effects, filesystem changes, code execution, email/calendar writes, credential
changes, and production actions must pass through authority classification and the appropriate execution
loop. These do not qualify for the read-only isolation path above and must use the full ToolInvocation
pre-flight and authority checkpoint (core-runtime §10.3–10.4).

ELORA should not directly execute Python routines, shell commands, database writes, or external connector
mutations outside CORE runtime contracts.

Tool use must preserve:

- validated input
- authority decision
- scoped execution
- normalized output
- receipt generation
- failure handling

## 14. ELORA Delegation Triggers

The generic AgentDelegation contract is defined by CORE runtime architecture. This section defines when
ELORA should trigger delegation.

ELORA may delegate when:

- the request requires specialized engineering execution
- the request requires bounded code inspection or patching
- the request requires a specialist actor's domain role
- the request is too large for direct response synthesis
- the request requires execution beyond ELORA's boundary
- the request has a clear WorkOrder and authority context

ELORA should not delegate vague work that lacks scope, expected output, or authority context.

Delegation should preserve:

- parent actor
- child actor
- source thread/message
- WorkOrder reference
- inherited context references
- authority scope
- expected return path
- completion criteria

## 15. ELORA-to-Nexora Delegation

ELORA-to-Nexora delegation is expected to be the first specialized delegation profile.

ELORA owns the executive side of the handoff. NEXORA.md should define the engineering execution side.

### 15.1 The Engineering Work Handshake

The expected handshake is:

ELORA identifies engineering intent.
ELORA normalizes the request into a scoped WorkOrder candidate.
CORE persists the WorkOrder.
CORE classifies authority.
ELORA creates or requests AgentDelegation to Nexora.
Nexora accepts or rejects the delegation through CORE contracts.
Nexora initiates execution when accepted.
Nexora returns receipts, artifacts, blockers, or completion state.
ELORA synthesizes the result back to the user.

Examples of engineering intent include:

- inspect repository state
- generate code change plan
- create or modify source files
- run tests or typechecks
- validate a patch
- produce implementation report
- identify cleanup candidates
- summarize execution blockers

### 15.2 Delegation Acceptance and Run Initialization

ELORA does not own Nexora's Run lifecycle.

ELORA creates or routes the WorkOrder and AgentDelegation. Nexora, upon accepting the delegation,
initiates the Run through CORE runtime contracts.

More precisely:

- CORE persists the Run.
- The executing actor initiates or requests the Run.
- ELORA should not initialize Nexora's Run before Nexora accepts delegated work.

This prevents ELORA from creating fake execution frames for work she does not execute.

## 16. Clarification and Escalation Behavior

ELORA should ask for clarification when a request cannot be interpreted or scoped safely.

Clarification is appropriate when:

- tenant/workspace/project context is ambiguous
- the requested outcome is unclear
- required files/resources are missing
- authority cannot be classified
- multiple interpretations are plausible
- execution would cross a boundary without confirmation
- user intent conflicts with repository doctrine or accepted ADRs

Escalation is appropriate when:

- authority outcome is escalate
- the request has high-risk external side effects
- the action impacts legal, financial, security, credential, production, or destructive surfaces
- user authorization is needed before proceeding
- required setup is missing

ELORA should keep clarification questions narrow and action-oriented.

## 17. Failure Modes

ELORA must fail clearly and preserve enough state for audit and recovery.

### 17.1 Context Resolution Failures

If tenant, workspace, project, actor, or thread context cannot be resolved, ELORA should not continue into
Message persistence or WorkOrder creation.

The failure should produce a clear response and, where possible, an ingestion-level failure record.

### 17.2 Intent Parse Failures Before WorkOrder

Intent parsing can fail before a WorkOrder or Run exists.

Do not create a Run merely to record a pre-WorkOrder failure.

Early-stage failures use the `IntentParseFailed` typed error (see 9.1) and produce receipt types or failure
records such as:

- ingestion_failed
- context_resolution_failed
- intent_parse_failed
- clarification_required

These are message-level or ingestion-level events, not run_failed receipts.

### 17.3 Authority Failures

Authority failures occur when a request cannot proceed under the current authority outcome.

Authority failures should produce clear responses such as:

- action requires escalation
- setup is required
- capability is missing
- action is refused
- scope is ambiguous

### 17.4 Delegation Failures

Delegation failures may occur when:

- no appropriate child actor exists
- required capability is missing
- authority is insufficient
- delegated scope is unclear
- child actor rejects the delegation
- child actor fails during execution

Delegation failures should preserve the WorkOrder and AgentDelegation state where applicable.

### 17.5 Response Synthesis Failures

Response synthesis failures occur when ELORA cannot safely produce a user-facing answer from available
state.

If synthesis fails, ELORA should avoid fabricating outcomes and should return a bounded failure response.

## 18. Ground-Zero ELORA v1

Ground-zero ELORA v1 is the deterministic executive ingestion layer that receives messages, interprets
intent, creates or routes WorkOrders, recommends or requests authority outcomes, creates
MemoryCandidates when appropriate, delegates engineering work to Nexora when explicitly available, and
synthesizes user-facing responses from CORE state.

### 18.1 Minimum Viable Capability Set

ELORA v1 should support:

- validated input normalization
- tenant/workspace/project/actor context resolution
- Thread and Message persistence through CORE
- inbound correlation handling
- intent interpretation through validated schemas
- WorkOrder creation for actionable requests
- authority outcome recommendation or write request, including deterministic `requires_human_gatekeeper`
  assignment (see 10.2)
- response synthesis
- MemoryCandidate proposal
- delegation trigger detection
- ELORA-to-Nexora delegation request when available
- failure classification before WorkOrder and before Run, including the `IntentParseFailed` typed error path
  (see 9.1)

ELORA v1 should not require mature multi-agent orchestration, workflow engines, embeddings, external
model-provider pipelines, or a full UI surface.

### 18.2 Prompt Contract and Context Isolation

This section defines prompt and context boundaries, not literal production prompt text.

Actual prompt copy should live in a future prompt registry, configuration file, or implementation-specific
prompt module. Stable architecture docs should not contain volatile prompt wording.

ELORA's prompt/context contract should distinguish:

- stable system role context
- active user message
- selected thread context
- selected memory context
- active WorkOrder context
- authority context
- delegation context
- tool result context
- excluded context

ELORA should not receive unrestricted repository state, full memory dumps, hidden credentials, unrelated
tenant data, or uncontrolled tool outputs.

## 19. Out-of-Scope for Ground Zero

ELORA.md inherits all ground-zero exclusions from /docs/architecture/core-runtime.md Section 18.

Additionally, ELORA-specific ground-zero exclusions include:

- real-time voice streams
- autonomous marketplace spending
- open-ended multi-agent loops
- mature council-room routing
- always-on background cognition
- autonomous external account mutation
- hidden prompt-only task queues
- direct database mutation by ELORA outside CORE contracts
- direct Python/shell execution by ELORA
- literal production prompt text in this document
- LLM-assigned authority outcomes or `requires_human_gatekeeper` values written directly to the database
  (see 10.2 — deterministic code owns this write, not the model)

Long-term ELORA refinement material may propose LangGraph, LlamaIndex, MCP servers, embeddings,
Google Workspace tools, observability, and mature agent workflows. Those remain proposed or deferred
unless ratified by an ADR or explicitly scoped by an active implementation prompt.

## 20. Long-Term ELORA Horizon

Long-term ELORA may become the primary executive intelligence interface for Vireon CORE and TCHAI
workflows.

Future capabilities may include:

- durable executive memory
- proactive briefing generation
- multi-thread project continuity
- routing across specialist agents
- council-room coordination
- UI-integrated command presence
- voice interaction
- long-running task supervision
- Google Workspace integration
- relationship-aware preference learning
- background synthesis
- advanced delegation policies

These are horizon capabilities. They are not ground-zero implementation scope.

The long-term horizon should shape architecture without overriding accepted ADRs, CORE runtime contracts,
or active implementation boundaries.

## 21. Relationship to Other Docs

ELORA.md sits below CORE runtime architecture and above implementation prompts.

```
README.md
 -> AGENTS.md
 -> ADR 0001: Ground-Zero Architecture
 -> docs/architecture/core-runtime.md
 -> ELORA.md
 -> NEXORA.md
 -> implementation prompts
```

### 21.1 README.md

README.md defines stable repository orientation.

ELORA.md should not duplicate README's broad project introduction or active phase boundaries.

### 21.2 AGENTS.md

AGENTS.md defines how AI coding agents should behave in the repository.

ELORA.md must remain consistent with its scope discipline, verification expectations, zero-ORM posture, and
anti-fake-capability rules.

### 21.3 ADR 0001

ADR 0001 defines the accepted ground-zero architecture.

ELORA.md must remain consistent with the local modular monolith, TypeScript runtime, PostgreSQL durable
state, Redis ephemeral coordination, bounded Python execution, and deferred distributed stack decisions.

### 21.4 core-runtime.md

/docs/architecture/core-runtime.md defines the generic CORE runtime primitives.

ELORA.md consumes those primitives and applies them to executive ingestion and coordination.

ELORA.md should not redefine core-runtime rules.

**Pending cross-document update:** per 9.1, core-runtime.md §8.3's `receipt_type` list should be updated to
include `intent_parse_failed` in the same implementation slice that introduces this document's §9.1 behavior,
so the receipt discriminated union (core-runtime §8.2) validates it correctly.

### 21.5 NEXORA.md

NEXORA.md should define Nexora as the engineering execution runtime.

ELORA.md defines the executive side of ELORA-to-Nexora delegation. NEXORA.md should define acceptance,
execution, validation, artifact production, and return receipts.

### 21.6 Implementation Prompts

Implementation prompts define the active task.

ELORA.md does not define the active sprint, current phase, or immediate coding instruction. Coding agents
must not infer active implementation tasking from this document alone.
