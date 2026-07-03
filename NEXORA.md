NEXORA.md
Engineering Execution Runtime

Document: /NEXORA.md
Project: Vireon CORE
Status: Draft v2 (tactical refinements folded in — schema-locking pass for Phase 0)
Date: 2026-07-03

Runtime boundary document for Nexora as the engineering execution layer of Vireon CORE.

## 1. Purpose

This document defines Nexora's runtime boundary inside Vireon CORE.

Nexora is the engineering execution runtime for CORE. Nexora receives scoped WorkOrders or
AgentDelegations, accepts or rejects engineering execution, initiates Runs through CORE runtime contracts,
inspects bounded workspaces, proposes or applies code changes when authorized, invokes validation tools,
produces ArtifactRecords, writes receipts through CORE, and returns structured completion or blocker state to
ELORA.

This is not a persona-lore document. Nexora's voice, character identity, and symbolic role may exist elsewhere,
but this file defines the runtime contract that governs what Nexora owns, consumes, executes, records, and
must never bypass.

The purpose of this file is to prevent implementation drift by making Nexora explicit:

- what Nexora receives
- how Nexora accepts or rejects delegated engineering work
- when Nexora initiates a Run
- how Nexora inspects workspaces and repositories
- how Nexora plans code changes
- how Nexora invokes tools and validation routines
- how Nexora interacts with Python workspace execution
- how Nexora produces artifacts
- how Nexora records receipts
- how Nexora returns results to ELORA
- what Nexora v1 should and should not attempt

Nexora inherits from the CORE runtime model. Nexora does not redefine database boundaries, tenant
isolation, receipt immutability, Redis behavior, Python execution rules, authority outcomes, or the generic
AgentDelegation contract.

## 2. Runtime Role

Nexora is the engineering execution layer positioned between CORE work coordination and bounded technical
implementation.

At ground zero, Nexora is responsible for engineering-side interpretation of a scoped WorkOrder, execution
planning, bounded repository inspection, patch proposal or patch application when authorized, validation
through approved tools, artifact production, and structured return of completion or blockers.

Nexora should not act as an unconstrained autonomous coding agent. Nexora operates through CORE
primitives and must preserve the runtime's state-first doctrine.

Nexora's role can be summarized as:

```
ELORA or CORE WorkOrder / AgentDelegation
 -> Nexora acceptance decision
 -> CORE Run initialization
 -> bounded workspace inspection
 -> engineering plan
 -> authorized ToolInvocation / Python workspace execution
 -> ArtifactRecord creation
 -> ActionReceipt creation
 -> completion, blocker, or failure return to ELORA
```

Nexora executes within bounded engineering scope. CORE persists and enforces. ELORA coordinates
user-facing ingestion and synthesis.

## 3. Relationship to CORE Runtime

Nexora consumes the primitives defined in /docs/architecture/core-runtime.md.

Nexora may consume or produce references to:

- Actor
- WorkOrder
- Run
- AuthorityDecision
- ToolInvocation
- AgentDelegation
- ActionReceipt
- ArtifactRecord
- MemoryCandidate
- Thread and Message references when needed for context

Nexora should not redefine the following CORE runtime contracts:

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

Nexora applies these primitives to engineering execution.

## 4. Nexora as Actor

Nexora is a CORE Actor.

As an actor, Nexora must be identifiable in Runs, ToolInvocations, ActionReceipts, ArtifactRecords,
AgentDelegations, and MemoryCandidate sources.

A Nexora actor reference should identify:

- actor_id
- actor_type: agent
- actor_name: Nexora
- actor_role: engineering_execution_runtime
- tenant scope
- workspace/project scope when applicable
- runtime capabilities
- authority context
- acting_system identifier

Nexora may appear in records as:

- accepting actor
- executing actor
- tool-invoking actor
- artifact-producing actor
- receipt-producing actor
- blocker-reporting actor
- engineering-analysis actor

Nexora should not appear as the actor that approved authority if the authority decision was made by CORE's
deterministic authority classifier, ELORA, the user, or another authorized actor. Nexora may request authority
classification but does not bypass it.

## 5. Inputs Nexora May Receive

Nexora may receive work only through CORE runtime channels.

Ground-zero inputs may include:

- WorkOrder references
- AgentDelegation records
- bounded repository/workspace references
- Thread/Message context references
- AuthorityDecision references
- ArtifactRecord references
- prior ActionReceipt references
- validated implementation prompts supplied through CORE
- failure or retry lineage from a prior Run

A normalized Nexora intake payload should include:

- tenant_id
- workspace_id when applicable
- project_id when applicable
- work_order_id
- agent_delegation_id when applicable
- parent_actor_id when delegated
- actor_id for Nexora
- source Thread/Message references when applicable
- authority context
- expected output
- bounded workspace root
- allowed operations
- received timestamp

Nexora must not accept free-floating prompts as execution authority. A direct natural-language instruction to
Nexora must first become CORE state through Message, WorkOrder, AuthorityDecision, and Run contracts as
applicable.

## 6. Intake Context Resolution Boundary

Before Nexora accepts work or starts a Run, the runtime must resolve context.

Context resolution maps an incoming WorkOrder or AgentDelegation to tenant, workspace, project, actor,
authority, and workspace scope.

### 6.1 Tenant Resolution

Tenant scope must be present before Nexora may inspect a workspace, invoke a tool, generate artifacts, or
initiate a Run.

If tenant scope cannot be resolved, Nexora must reject the intake or return a bounded failure.

Nexora must not guess across tenants.

### 6.2 Workspace / Project Resolution

Workspace and project scope determine the operational boundary for engineering execution.

A workspace may map to a repository, local project root, generated artifact area, or isolated code workspace.

If the target workspace or project is ambiguous, Nexora should return a blocker rather than inspecting or
modifying the wrong files.

### 6.3 Actor Resolution

Nexora must resolve:

- the requesting actor
- the delegating actor when applicable
- the executing actor reference for Nexora
- the authority-deciding actor/system when applicable

Actor references should be preserved in Runs, ToolInvocations, ActionReceipts, and ArtifactRecords.

### 6.4 Authority Context Resolution

Nexora must know what authority scope applies before execution.

If authority is missing or insufficient, Nexora should request authority classification or return an authority
blocker.

Nexora must not convert ambiguous authority into execution.

### 6.5 Ambiguity Failure Rules

If tenant, workspace, project, actor, authority, or target resource scope cannot be resolved, Nexora must fail
clearly.

Ambiguity should lead to one of the following:

- delegation_rejected
- setup_required
- capability_missing
- clarification_required
- authority_escalation_required
- bounded failure receipt

## 7. WorkOrder and AgentDelegation Intake

Nexora receives engineering work through WorkOrders and AgentDelegations.

A WorkOrder defines intended work. An AgentDelegation records that another actor has assigned or routed
that work to Nexora.

### 7.1 WorkOrder Eligibility

Nexora should accept only WorkOrders that are engineering-relevant and scoped enough to execute or
analyze.

Eligible work may include:

- repository inspection
- source-code modification
- test or typecheck execution
- migration drafting
- runtime schema implementation
- bug investigation
- dependency cleanup
- documentation generation tied to technical implementation
- architecture-to-code translation
- sandbox validation
- patch planning

Nexora should reject or return blockers for WorkOrders that are:

- non-engineering in nature
- missing workspace boundaries
- missing authority context
- too vague to execute
- outside repository doctrine
- requiring unavailable tools or setup
- requiring external side effects without authority

### 7.2 Delegation Acceptance

Nexora must explicitly accept or reject delegated work through CORE contracts.

Acceptance should record:

- delegated WorkOrder reference
- AgentDelegation reference
- accepting actor
- scope accepted
- authority context accepted
- expected output
- initial execution mode
- timestamp

Rejection should record:

- reason
- missing context or capability
- suggested clarification or setup
- whether the delegation may be retried

Nexora should not start execution before acceptance is recorded.

### 7.3 Delegation Idempotency

Delegation acceptance should respect the CORE idempotency model.

A repeated delegation acceptance with the same tenant_id and idempotency_key should fetch the existing
acceptance or Run boundary rather than creating duplicate execution frames.

The idempotency key may be derived from:

- tenant_id
- work_order_id
- agent_delegation_id
- nexora actor_id
- requested operation
- attempt number or retry lineage

### 7.4 Intake Receipts

Meaningful intake decisions should produce receipts.

Potential receipt types include:

- delegation_accepted
- delegation_rejected
- engineering_scope_classified
- engineering_blocker_identified

These receipt types may need to be added to core-runtime receipt definitions when implemented.

## 8. Run Lifecycle Boundary

A Run is the execution attempt associated with a WorkOrder.

Nexora does not create hidden execution frames. When Nexora accepts engineering work, the Run must be
initiated through CORE runtime contracts.

### 8.1 Run Ownership Split

CORE owns Run persistence and state validation.

Nexora owns the engineering-side execution behavior associated with an accepted Run.

The split is:

- CORE persists the Run.
- Nexora requests or initiates Run creation through CORE contracts.
- CORE validates the transition.
- Nexora performs bounded engineering execution.
- CORE records receipts and state transitions.

### 8.2 Run Initialization on Acceptance

After delegation acceptance, Nexora may initiate a Run when:

- the WorkOrder is engineering-relevant
- tenant/workspace/project scope is resolved
- authority context permits the planned execution mode
- workspace boundaries are configured
- required tools or validation routines are available

Run initialization should record:

- work_order_id
- agent_delegation_id when applicable
- nexora actor_id
- run status
- attempt number
- start timestamp
- execution mode
- expected validation commands when known
- idempotency key

### 8.3 No Fake Runs

Nexora must not create a Run to simulate work that has not been accepted or attempted.

If work is blocked before execution, Nexora should return a blocker or failure receipt without pretending a full
execution Run occurred.

Pre-Run blockers may include:

- missing workspace
- missing authority
- missing capability
- ambiguous task
- out-of-scope request
- setup required

### 8.4 Run State Transitions

Run state transitions should be explicit and validated.

Potential states include:

- pending
- accepted
- planning
- inspecting
- executing
- validating
- blocked
- failed
- completed
- cancelled

Ground zero does not need every state immediately, but the state model should leave room for inspectable
execution progress.

### 8.5 Retry and Resume Semantics

Nexora retries must resume from the last durable boundary.

Durable boundaries may include:

- accepted delegation
- initialized Run
- completed repository inspection
- generated patch proposal
- completed ToolInvocation
- produced ArtifactRecord
- written ActionReceipt

Retries must not blindly replay a model-generated patch, re-run an external side effect, duplicate a receipt, or
apply a patch twice.

## 9. Workspace and Repository Boundary

Nexora may inspect or modify workspaces only within configured boundaries.

A workspace boundary may include:

- repository root
- allowed file paths
- denied file paths
- temporary working directory
- artifact output directory
- test command allowlist
- network access policy
- credential access policy
- maximum runtime duration

### 9.1 Repository Inspection

Repository inspection should be bounded and purposeful.

Nexora may inspect:

- file tree structure
- package manifests
- configuration files
- source files relevant to the WorkOrder
- tests relevant to the WorkOrder
- migration files relevant to the WorkOrder
- documentation relevant to the WorkOrder

Nexora should not load the entire repository blindly when a smaller scoped inspection is enough.

### 9.2 File Access Rules

Nexora must respect workspace file boundaries.

Nexora should not access:

- files outside the configured workspace root
- secrets or credential files unless explicitly authorized and safely handled
- unrelated tenant or project files
- production-only configuration
- private keys
- unrelated user data

### 9.3 Patch Scope

A patch should be scoped to the WorkOrder.

Nexora should not opportunistically rewrite unrelated files, reorganize the project, or add speculative
abstractions because they seem useful.

If related cleanup is discovered, Nexora should report it under recommended next steps rather than
implementing it outside scope.

### 9.4 Workspace Mutation Safety

Before mutating files, Nexora should have:

- resolved workspace scope
- authority classification
- a clear expected output
- a rollback or diff path
- a receipt plan
- validation plan where practical

File mutations should be inspectable through diffs and artifacts.

## 10. Engineering Planning and Patch Strategy

Nexora should plan before executing meaningful engineering changes.

Planning does not mean producing passive previews forever. It means establishing a bounded execution path
before touching files or invoking tools.

### 10.1 Engineering Plan

An engineering plan should identify:

- intended change
- affected files
- expected behavior
- validation commands
- authority requirements
- risks
- rollback path
- artifacts expected

For small, low-risk, explicitly scoped tasks, the plan may be minimal and embedded in the receipt.

### 10.2 Patch Proposal vs Patch Application

Nexora may produce a patch proposal when:

- authority is insufficient for direct mutation
- the WorkOrder asks for review before edit
- workspace mutation is not available
- implementation is uncertain
- the change is high-risk

Nexora may apply a patch when:

- authority permits mutation
- workspace boundaries are configured
- expected files are known
- validation path exists or failure can be reported
- receipt generation is available

### 10.3 Diff Discipline — Canonical Patch Format

Nexora standardizes on a single canonical patch format at ground zero: the **standard unified diff**
(POSIX `diff -u` style). This is the sole supported format for both patch proposals and patch applications.

**Rationale for a single format.** An earlier draft of this section allowed unified diffs or a structured JSON
line-modification format as interchangeable alternatives. That optionality is rejected here: supporting two
formats means maintaining two Zod validators, two apply-paths, and two things that can silently drift out of
sync with each other over time. Unified diff is chosen as the sole ground-zero format because it is directly
consumable by existing, already-trusted tooling (`git apply`, `patch`) without Nexora needing to implement
and maintain a custom structural applier. A structured JSON patch format (e.g. line-range replace objects)
remains a candidate for a later milestone, but is explicitly deferred rather than stood up in parallel with
unified diff at ground zero.

Every patch Nexora generates, proposes, or applies must:

- be structurally generated as a valid unified diff (correct hunk headers, correct line counts, no
  hand-assembled search-and-replace strings masquerading as a diff)
- be validated against a Zod schema that checks unified-diff structural well-formedness before the patch
  is persisted as an artifact or passed to an apply step
- be applied only through a unified-diff-aware apply mechanism (e.g. `git apply` against the bounded
  workspace), never through ad hoc string replacement against file contents
- reference the exact file(s) and hunks touched, so a diff summary (see 13) can be derived mechanically
  rather than narrated

A diff should make it clear:

- what changed
- which files changed
- why the change was made
- how the change was validated
- whether any validation failed

### 10.4 Avoiding Placeholder Bloat

Nexora must not create placeholder modules, fake systems, unused abstractions, or future-phase scaffolding
unless explicitly scoped.

If a future module is needed later, Nexora should document it as a next step rather than creating dead
structure now.

## 11. Tool Invocation and Validation Boundary

Nexora may invoke tools only through CORE ToolInvocation contracts.

Tools may include:

- repository inspection utilities
- file read/write utilities
- test runners
- typecheck commands
- lint commands
- patch application utilities
- Python workspace runners
- future connector tools when explicitly scoped

### 11.1 Tool Pre-Flight — Database Validation Pattern

Before invoking any **mutating** file tool (patch application, file write, file delete), the TypeScript
orchestrator must perform a deterministic database check as part of tool pre-flight, inside the current
active, tenant-scoped transaction:

```sql
SELECT outcome, requires_human_gatekeeper
FROM authority_decisions
WHERE tenant_id = $1
  AND id = $2   -- the authority_decision_id referenced by the WorkOrder/ToolInvocation
FOR UPDATE;     -- lock the row for the duration of this pre-flight check
```

The pre-flight check must evaluate **both** columns, not `outcome` alone:

1. `outcome` must be `act` or `act_and_report`. Any other outcome (`escalate`, `setup_required`,
   `capability_missing`, `refuse`) fails pre-flight immediately.
2. `requires_human_gatekeeper` must be `false`, **or**, if `true`, there must be a separately recorded
   human approval satisfying that gate (tracked through its own durable record, not inferred). A row with
   `outcome: act_and_report` and `requires_human_gatekeeper: true` does **not** pass pre-flight on
   `outcome` alone — checking `outcome` in isolation would let an unresolved human-gatekeeper
   requirement slip through, which is exactly the spoofing path ELORA §10.2 exists to close on the write
   side. Nexora's pre-flight is the corresponding read-side enforcement of that same boundary.

If either condition fails, the orchestrator must abort the transaction immediately and throw a strongly-typed
`PreFlightValidationFailed` exception — the mutating tool block must never begin execution. This mirrors the
`IntentParseFailed` pattern established in ELORA.md §9.1: a named, typed failure rather than a generic
exception, with the transaction rolled back cleanly rather than left open.

Read-only tools (repository inspection, file read) are not required to pass this specific mutating-tool
pre-flight, but remain subject to the general pre-flight checks below and to workspace boundary rules (9.2).

Before invoking a tool, Nexora or the CORE runtime should also verify:

- tool availability
- input schema validity
- workspace scope
- expected side effects
- timeout and resource limits (see 12.3)
- idempotency key when required

### 11.2 Validation Commands

Validation should be appropriate to the changed surface.

Potential validation commands include:

- pnpm typecheck
- pnpm test
- pnpm lint
- targeted test command
- migration dry-run
- static analysis
- formatting check

If no validation can be run, Nexora must report why.

Nexora must not claim tests passed without running them.

### 11.3 Tool Result Normalization

Tool outputs should be normalized before being returned, persisted, or summarized.

Normalized results should include:

- tool identifier
- status
- exit code when applicable
- stdout
- stderr
- duration
- changed files
- artifacts produced
- error type
- error message

### 11.4 Validation Failure Handling

Validation failure does not automatically mean the Run is worthless.

Nexora should preserve:

- what was attempted
- what failed
- relevant output
- likely cause when known
- rollback status
- recommended next step

A failed validation may still produce artifacts and receipts.

## 12. Python Workspace Execution Boundary

Python may support Nexora's bounded workspace execution, but Python does not own CORE state.

### 12.1 Python Ownership

Python may own:

- subprocess orchestration
- bounded workspace execution
- patch validation helpers
- AST/code inspection utilities
- test/lint/typecheck invocation wrappers
- potentially unsafe routines inside configured boundaries

Python must not own:

- database access
- tenant context
- authority decisions
- receipt persistence
- durable memory
- tool governance
- Run state

### 12.2 Python Invocation

Nexora may request Python execution through a CORE ToolInvocation or bounded execution contract.

Python execution must receive validated input and return structured output.

Python must not receive unrestricted repository access by default.

### 12.3 Sandbox Controls — Ground-Zero Execution Mechanism

Ground-zero Python invocation must use a specific, hard-coded mechanism rather than a generically
described sandbox. This closes the gap where "sandbox controls" as loose bullet points invites inconsistent
implementation choices during code generation.

**Process spawning.** Python execution must be invoked from the TypeScript orchestrator via Node's
`child_process.spawn`, targeting the Python interpreter inside an isolated virtual environment (`venv`)
scoped to the bounded workspace. `spawn` is used rather than `exec` so arguments are passed as an array
and never interpolated into a shell string.

**Environment isolation.** Environment mutation vectors are stripped through the `env` option on `spawn()`,
not through `execArgv`. `execArgv` is a Node-specific mechanism for passing flags to a *Node* child
process and has no meaning when the child process is a Python interpreter — it does not apply here. The
correct mechanism is to construct an explicit allowlist environment object and pass it as `spawn(cmd, args,
{ env: allowlistedEnv, cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] })`, rather than inheriting
`process.env`. The allowlisted environment must exclude host credentials, unrelated service tokens, and any
variable not explicitly required for the bounded execution.

**Timeout model.** Ground zero does not use a single flat timeout applied uniformly to every tool invocation.
Instead:

- each validation command carries its own default timeout as part of its tool profile (e.g. a `pnpm lint`
  profile times out sooner than a full `pnpm test` profile);
- every profile's timeout is capped by a hard outer ceiling of 300,000ms (5 minutes) per tool invocation —
  no profile, however configured, may exceed this ceiling at ground zero;
- a timeout firing must terminate the child process, mark the ToolInvocation as timed out, and proceed
  through the same cleanup path as any other execution failure (12.4).

**stdio handling.** `stdio` must be configured as pipes (`'pipe'` for stdout/stderr, `'ignore'` or a closed pipe
for stdin) rather than `'inherit'`. This prevents the child process from leaking into or reading from the
orchestrator's own process I/O, and ensures stdout/stderr are captured programmatically for the Python
return payload (12.5) rather than written directly to a shared terminal or log stream.

### 12.4 Cleanup and Zombie Handling

Sandboxed or bounded execution must include cleanup behavior.

Cleanup should address:

- temporary workspace removal
- stale process cleanup
- timeout-triggered termination (see 12.3)
- zombie process/container detection when containers are used
- stdout/stderr capture before cleanup
- cleanup failure reporting

### 12.5 Python Return Payload

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

The TypeScript runtime validates Python return payloads before persistence or synthesis.

## 13. ArtifactRecord Boundary

Nexora may produce artifacts during engineering execution.

Artifacts are durable or semi-durable outputs linked to a WorkOrder, Run, actor, and receipt.

Potential artifacts include:

- patch file (unified diff — see 10.3)
- diff summary
- modified source file reference
- generated document
- test report
- validation report
- migration file
- architectural note
- cleanup report
- blocker report

### 13.1 Artifact Creation Rules

Artifacts should include:

- artifact_id
- tenant_id
- workspace_id/project_id when applicable
- work_order_id
- run_id when applicable
- actor_id
- artifact type
- storage reference or content pointer
- created timestamp
- related receipt_id

### 13.2 Artifact Scope

Artifacts should be scoped to the work performed.

Nexora should not generate large artifact bundles when a concise report or diff is sufficient.

### 13.3 Artifact Receipts

Meaningful artifacts should be referenced by receipts.

A receipt should make it possible to answer:

- why the artifact exists
- what generated it
- which WorkOrder/Run it belongs to
- whether it was validated
- what should happen next

## 14. Receipt Responsibilities

Nexora must produce or request receipts for meaningful engineering actions.

Receipts are append-only and immutable. Nexora must not mutate historical receipts.

### 14.1 Engineering Receipt Types

Potential Nexora receipt types include:

- delegation_accepted
- delegation_rejected
- run_started
- repo_inspected
- patch_planned
- patch_applied
- validation_run
- validation_failed
- validation_passed
- artifact_created
- engineering_blocked
- run_failed
- run_completed
- preflight_validation_failed

These receipt types may need to be added to core-runtime receipt definitions when implemented. This
includes `preflight_validation_failed`, added here to correspond to the `PreFlightValidationFailed` exception
defined in 11.1 — the failure should be as auditable as any other meaningful engineering event.

### 14.2 Receipt Content

Engineering receipts should capture:

- WorkOrder reference
- Run reference when applicable
- AgentDelegation reference when applicable
- actor/system
- authority decision reference
- action taken
- files inspected
- files changed
- tools invoked
- commands run
- validation results
- artifacts produced
- errors
- rollback hints
- recommended next steps

### 14.3 No Passive Fake Completion

Nexora must not simulate completed work with passive preview artifacts.

If Nexora only planned, inspected, or proposed, the receipt must say that.

If Nexora executed, the receipt must identify what changed and how it was validated.

## 15. Authority Boundaries

Nexora is authority-bound.

Nexora may not execute external side effects, workspace mutations, code commits, production writes, or
connector mutations without authority classification.

### 15.1 Engineering Authority Levels

Engineering work may require different authority levels depending on risk.

Examples:

- read-only repository inspection
- local patch proposal
- local file mutation
- test command execution
- dependency installation
- migration creation
- code commit
- pull request creation
- deployment or production mutation

Ground zero should prefer read-only inspection, local patch generation, and local validation before external
repository or production mutation.

### 15.2 Human Gatekeeper Escalation

If authority requires human gatekeeping, Nexora should return a blocker or escalation request rather than
executing.

Nexora must not downgrade authority requirements to proceed. Concretely, this means the mutating-tool
pre-flight check in 11.1 is the enforcement point: Nexora code paths must not route around it, cache a stale
"approved" result, or re-check only `outcome` while skipping `requires_human_gatekeeper`.

### 15.3 External Side Effects

External side effects include:

- pushing commits
- opening pull requests
- changing remote repository settings
- calling external APIs
- modifying cloud infrastructure
- sending emails or calendar updates
- changing credentials
- installing dependencies from network sources when not explicitly authorized

These require explicit authority handling and are not ground-zero defaults.

## 16. Return Path to ELORA

Nexora returns structured execution state to ELORA through CORE records.

ELORA synthesizes the user-facing response. Nexora should return enough structured information for ELORA
to explain what happened clearly.

### 16.1 Completion Return

A completion return should include:

- WorkOrder reference
- Run reference
- completion status
- summary of action taken
- files changed
- artifacts produced
- validation commands run
- validation outcome
- receipts created
- known limitations
- recommended next steps

### 16.2 Blocker Return

A blocker return should include:

- blocker type
- reason
- missing input/setup/capability/authority
- whether retry is possible
- recommended user action
- related WorkOrder/Run/Delegation references

### 16.3 Failure Return

A failure return should include:

- failure type
- failure message
- state at failure
- rollback status
- artifacts preserved
- stdout/stderr when applicable
- retry recommendation
- receipt reference

## 17. Failure Modes

Nexora must fail clearly and preserve enough state for audit and recovery.

### 17.1 Intake Failures

Intake failures occur before Nexora accepts work.

Examples:

- missing WorkOrder
- missing AgentDelegation
- unclear tenant/workspace/project scope
- missing authority context
- non-engineering WorkOrder
- unavailable workspace

These should not create fake Runs.

### 17.2 Run Initialization Failures

Run initialization failures occur after Nexora accepts work but before execution begins.

Examples:

- database transaction failure
- idempotency conflict with incompatible existing Run
- state transition failure
- authority mismatch
- workspace setup failure

These should be recorded without pretending execution occurred.

### 17.3 Workspace Execution Failures

Workspace execution failures occur during repository inspection, patch application, validation, or Python
execution.

Examples:

- file not found
- denied path access
- patch conflict
- test failure
- typecheck failure
- subprocess timeout (see 12.3)
- sandbox cleanup failure

These should produce normalized failure records and receipts.

### 17.4 Authority Failures

Authority failures occur when the requested engineering action cannot proceed under the current authority
decision.

This includes `PreFlightValidationFailed` (11.1) — a mutating tool block that fails the `outcome` /
`requires_human_gatekeeper` pre-flight check is an authority failure, not a workspace or tool failure, and
should be classified and receipted accordingly (`preflight_validation_failed`, 14.1).

Nexora should return an escalation or setup blocker rather than executing.

### 17.5 Validation Failures

Validation failures should be captured with command output and structured analysis when possible.

Nexora should not hide failed tests or present the task as complete.

### 17.6 Response Return Failures

If Nexora cannot return a normal completion payload, it should return a bounded failure payload through
CORE state rather than relying on hidden agent memory.

## 18. Ground-Zero Nexora v1

Ground-zero Nexora v1 is the bounded engineering execution runtime that accepts scoped engineering
WorkOrders or AgentDelegations, initiates Runs through CORE contracts, inspects local workspaces, proposes
or applies authorized patches, invokes validation tools, records artifacts and receipts, and returns structured
results or blockers to ELORA.

### 18.1 Minimum Viable Capability Set

Nexora v1 should support:

- WorkOrder and AgentDelegation intake
- context resolution for tenant/workspace/project/actor/authority
- delegation acceptance or rejection
- Run initiation through CORE contracts
- bounded workspace inspection
- scoped engineering planning
- patch proposal and patch application as unified diffs only (see 10.3)
- mutating-tool pre-flight against `authority_decisions.outcome` and
  `authority_decisions.requires_human_gatekeeper` (see 11.1)
- validation command invocation
- Python workspace execution through the `child_process.spawn` + `venv` + allowlisted `env` boundary
  (see 12.3)
- ArtifactRecord creation
- ActionReceipt creation
- completion/blocker/failure return to ELORA

Nexora v1 should not require mature multi-agent orchestration, LangGraph, LlamaIndex, MCP servers,
external model-provider pipelines, external repository mutation, production deployments, or a full UI surface.

### 18.2 Prompt Contract and Context Isolation

This section defines prompt and context boundaries, not literal production prompt text.

Actual prompt copy should live in a future prompt registry, configuration file, or implementation-specific
prompt module. Stable architecture docs should not contain volatile prompt wording.

Nexora's prompt/context contract should distinguish:

- active WorkOrder context
- AgentDelegation context
- authority context
- repository/workspace context
- selected files
- validation output
- artifact references
- prior receipts
- excluded context

Nexora should not receive unrestricted repository state, full memory dumps, hidden credentials, unrelated
tenant data, or uncontrolled tool outputs.

## 19. Out-of-Scope for Ground Zero

NEXORA.md inherits all ground-zero exclusions from /docs/architecture/core-runtime.md Section 18.

Additionally, Nexora-specific ground-zero exclusions include:

- autonomous repository mutation without authority
- direct production deployment
- direct cloud infrastructure mutation
- direct credential handling
- unrestricted shell execution
- unrestricted filesystem access
- direct database mutation by Nexora outside CORE contracts
- direct connection from Python to the primary database pool
- external model-provider orchestration pipelines
- open-ended multi-agent coding loops
- autonomous dependency installation from the network
- pushing commits or opening pull requests unless explicitly scoped
- literal production prompt text in this document
- fake execution receipts for work not performed
- structured JSON patch format as a parallel patch mechanism (see 10.3 — deferred, not adopted alongside
  unified diff)
- `execArgv`-based environment stripping for Python subprocess isolation (see 12.3 — not applicable to a
  non-Node child process; `env` allowlisting is the ground-zero mechanism)

Long-term Nexora refinement material may propose LangGraph, LlamaIndex, MCP servers, external coding
agents, observability, remote execution, durable workflow engines, and advanced sandboxing. Those remain
proposed or deferred unless ratified by an ADR or explicitly scoped by an active implementation prompt.

## 20. Long-Term Nexora Horizon

Long-term Nexora may become the primary engineering execution intelligence for Vireon CORE.

Future capabilities may include:

- continuous repository understanding
- autonomous issue triage
- multi-step implementation planning
- patch generation and validation
- pull request creation
- CI/CD analysis
- secure dependency management
- migration assistance
- architecture-to-code translation
- engineering memory integration
- advanced sandbox execution
- distributed worker coordination
- collaboration with additional specialist agents

These are horizon capabilities. They are not ground-zero implementation scope.

The long-term horizon should shape architecture without overriding accepted ADRs, CORE runtime contracts,
or active implementation boundaries.

## 21. Relationship to Other Docs

NEXORA.md sits below CORE runtime architecture and alongside ELORA.md.

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

NEXORA.md should not duplicate README's broad project introduction or active phase boundaries.

### 21.2 AGENTS.md

AGENTS.md defines how AI coding agents should behave in the repository.

NEXORA.md must remain consistent with its scope discipline, verification expectations, zero-ORM posture, and
anti-fake-capability rules.

### 21.3 ADR 0001

ADR 0001 defines the accepted ground-zero architecture.

NEXORA.md must remain consistent with the local modular monolith, TypeScript runtime, PostgreSQL durable
state, Redis ephemeral coordination, bounded Python execution, and deferred distributed stack decisions.

### 21.4 core-runtime.md

/docs/architecture/core-runtime.md defines the generic CORE runtime primitives.

NEXORA.md consumes those primitives and applies them to engineering execution.

NEXORA.md should not redefine core-runtime rules.

### 21.5 ELORA.md

ELORA.md defines ELORA as the executive ingestion and coordination runtime.

NEXORA.md specifies acceptance, execution, validation, artifact production, and return receipts from the
engineering execution perspective, consuming the delegation frames initialized by ELORA.

### 21.6 Implementation Prompts

Implementation prompts define the active task.

NEXORA.md does not define the active sprint, current phase, or immediate coding instruction. Coding agents
must not infer active implementation tasking from this document alone.

## 22. Pending Cross-Document Updates

The following updates to sibling documents are required in the same implementation slice that introduces
the behavior defined in this revision, so schema validation does not reject records this document now
requires:

- core-runtime.md §8.3 `receipt_type` list should add: `delegation_accepted`, `delegation_rejected`,
  `engineering_scope_classified`, `engineering_blocker_identified` (7.4), `run_started`, `repo_inspected`,
  `patch_planned`, `patch_applied`, `validation_run`, `validation_failed`, `validation_passed`,
  `artifact_created`, `engineering_blocked` (14.1), and `preflight_validation_failed` (11.1 / 14.1).
- core-runtime.md's typed error catalogue (§16.1) should add `PreFlightValidationFailed` alongside
  `IntentParseFailed` (ELORA.md §9.1), since both now follow the same "typed error, clean rollback, standalone
  receipt" pattern and future implementers should be able to find them listed together.
