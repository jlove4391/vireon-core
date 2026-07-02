# AGENTS.md
## Vireon CORE - AI Coding-Agent Operating Contract

## Purpose

This file defines mandatory operating rules for AI coding agents working inside the Vireon CORE repository.

It applies to Codex, Claude Code, Cursor, and any other AI-assisted coding tool that reads or modifies this codebase.

The purpose of this file is to prevent scope drift, fake capability, unsafe data access, architectural inconsistency, and unverified changes.

## Authority of This File

* The active user prompt defines the current implementation task.
* This file defines the standing repository rules that apply unless the user explicitly overrides them.
* Do not infer the active task, current phase, or sprint objective from `README.md`. Active tasking is supplied manually by the user in implementation prompts.
* If the active prompt conflicts with this file, do not silently choose. Surface the conflict clearly in the completion report or ask for clarification if execution cannot proceed safely.

## Operating Mode

* Work in small, verified implementation slices.
* Prefer simple, deterministic, testable code over broad scaffolding.
* Do not expand the task beyond the requested files, functions, schemas, tests, or migrations.
* If related work is discovered, document it under `Recommended Next Steps` instead of implementing it.

## Repository Orientation

Vireon CORE is a state-centric relational operating runtime.

The repository is built around:

* Explicit state transitions
* Work orders
* Authority decisions
* Immutable action receipts
* Memory candidates
* Governed tool invocations
* Tenant-isolated data access
* Deterministic orchestration
* Bounded agent execution

ELORA, Nexora, and future agents must operate through CORE contracts. They do not bypass work orders, authority decisions, receipts, memory boundaries, or tool governance.

## Scope Discipline

* Only modify files required by the active task.
* Do not create placeholder systems for future phases.
* Do not add speculative abstractions.
* Do not introduce new infrastructure unless explicitly requested.
* Do not implement adjacent features because they seem useful.
* Do not convert the repository into a distributed service architecture before the local modular monolith foundation is proven.
* If a task requires files that do not yet exist, create only the minimum files required to complete the task.

## Implementation Rules

* Use TypeScript / Node.js for deterministic runtime state, orchestration, schemas, database access, authority decisions, receipts, and identity boundaries.
* Use Python only for bounded local workspace execution, patch validation, subprocess checks, test execution, and potentially unsafe execution routines.
* **Python code must not connect directly to the primary database pool.**
* Avoid hidden prompt loops as architecture. Use explicit schemas, state machines, persisted records, and verifiable transitions.
* Prefer clear functions with narrow responsibility.
* Avoid vague names such as `manager`, `handler`, `processor`, or `helper` when a more specific domain name is available.

## Package and Dependency Rules

* Do not install heavy ORMs such as Prisma, Drizzle, TypeORM, Sequelize, or similar database abstraction layers unless the architecture is explicitly revised.
* Database access uses raw, parameterized SQL through `node-postgres` (`pg`).
* Use Zod for runtime payload validation.
* Use `ioredis` for Redis-backed state mutation locks when Redis is required.
* Do not add unnecessary packages.
* Before adding a dependency, verify that the task cannot be completed cleanly with existing project tools or a small local module.

## Database Rules

Tenant-scoped database access must use explicit transaction boundaries.

Every tenant-scoped database operation must:

1. Acquire an isolated client from the PostgreSQL pool
2. Begin a transaction
3. Set transaction-scoped tenant context
4. Execute parameterized queries
5. Commit on success
6. Rollback on failure
7. Release the client in a `finally` block

Use transaction-scoped tenant context through exactly this functional format:

```sql
SELECT set_config('vireon.current_tenant_id', $1, true)
```

* Do not run tenant-scoped SQL outside this pattern.
* Do not concatenate raw user input into SQL strings.
* Do not bypass PostgreSQL row-level security.
* Do not treat Redis as the source of truth for CORE state.
* Redis may be used for short-lived locks, cache, or ephemeral coordination only.

## Runtime Schema Rules

* All payloads crossing runtime boundaries must be validated through Zod schemas.
* Do not rely on TypeScript type assertions alone for external, database-loaded, tool-returned, model-returned, or user-provided data.
* Avoid unchecked JSON objects.
* Avoid loose `any`.
* Avoid unsafe casts.
* Every important runtime object should have a schema and inferred TypeScript type.
* Core schemas should remain explicit, readable, and stable.

## State Machine Rules

* State transitions must be explicit and validated.
* Invalid transitions must fail clearly.
* Do not mutate work order state casually.
* Do not skip intermediate authority, receipt, or audit requirements.
* State transitions should be durable, inspectable, and replayable where practical.

A state transition should record:

* Previous state
* Next state
* Actor
* Reason
* Timestamp
* Related work order
* Related tenant/workspace/project scope

## Authority Rules

Authority decisions are risk-based.

Supported authority outcomes are:

* `act`
* `act_and_report`
* `escalate`
* `setup_required`
* `capability_missing`
* `refuse`

* Do not design approval-first behavior by default.
* Do not execute external side effects without an authority decision.
* Do not treat user authorization as a bypass. Treat authorization as a recorded state transition that still requires bounded execution, validation, and receipts.

## Receipt Rules

* Meaningful actions must produce durable audit records.
* Receipts and audit records are append-only.
* Do not mutate historical receipts in place.
* If a correction, reversal, or supersession is required, create a new record that references the prior record.

Receipts should eventually capture:

* Original request
* Interpreted intent
* Acting system
* Authority decision
* Tools used
* Inputs accessed
* Actions taken
* Outputs produced
* State transitions
* Files changed
* Errors
* Rollback hints
* Memory candidates
* Follow-up tasks

* Do not simulate completed work with passive preview artifacts.
* Either execute within the current boundary or return a clear `setup`, `capability`, or `authority` limitation.

## Memory Rules

* Durable memory must not be written blindly.
* New memory should first be represented as a memory candidate.
* Memory candidates should include enough context to review, reject, consolidate, or promote later.
* Do not store noisy, temporary, contradictory, or low-confidence information as durable memory without a review path.
* Receipts may create memory candidates, but receipts are not the same thing as memory.

## Tool and Sandbox Rules

* Tools must be governed, scoped, logged, and validated.
* Do not give agents unrestricted filesystem, shell, network, credential, or production access.
* Sandboxed execution must be bounded by workspace root, timeout, CPU/memory limits, and cleanup routines.
* Python workspace runners must operate only inside configured workspace boundaries.
* Sandbox output must capture stdout, stderr, exit codes, duration, changed files, and errors.
* Cleanup failures must be reported.

## Security Rules

* Do not hardcode secrets, tokens, credentials, connection strings, or private keys.
* Do not print secrets in logs.
* Do not commit `.env` files.
* Do not weaken tenant isolation to make a test pass.
* Do not bypass validation, authority, or receipt requirements to simplify implementation.
* Do not introduce network calls to external providers unless the active task explicitly requires them.

## Error Handling Rules

* Fail fast and fail clearly.
* State validation errors, authority errors, tenant-boundary failures, receipt failures, and database transaction errors must not be swallowed.
* Prefer typed error classes or clearly named error objects where useful.
* Error messages should be specific enough to debug without exposing secrets.
* Do not return silent success when a required operation fails.

## Testing and Verification Rules

Every implementation slice must include verification.

Run the commands requested in the active prompt.

If no commands are specified, default to:

* `pnpm typecheck`
* `pnpm test`

* If scripts do not exist yet, add the minimum required scripts only when the active task requires verification.
* Do not claim completion if typecheck or tests fail.
* If verification cannot be run, explain exactly why.
* Tests should verify behavior, not merely existence.
* At minimum, state machine work should test valid and invalid transitions.
* Database work should test tenant-scoped behavior where practical.

## Documentation Rules

* Update documentation only when the active task requires it or when implementation changes make existing documentation misleading.
* Do not rewrite doctrine files casually.
* Do not move active phase tracking into README.
* Do not add sprint-level status to stable architecture documents.
* If the implementation reveals a future task, record it in the completion report under `Recommended Next Steps` instead of editing stable docs.

## Prohibited Behaviors

Do not:

* Build beyond the active task
* Create fake capability
* Add placeholder modules
* Add unused abstractions
* Introduce heavy ORMs
* Bypass Zod validation
* Bypass tenant isolation
* Bypass authority decisions
* Mutate receipts in place
* Connect Python runners to the primary database pool
* Treat Redis as durable state
* Hardcode secrets
* Silently swallow errors
* Claim tests passed without running them
* Infer the current phase from README
* Rewrite architecture doctrine unless explicitly instructed

## Completion Report Format

When finished, report precisely:

1. Files created
2. Files modified
3. Commands run
4. Test results
5. Known limitations
6. Recommended next steps

If any verification step fails, report the failure clearly and do not present the task as complete.

If scope conflicts were discovered, report them clearly.

If related work was discovered but not implemented, place it under `Recommended Next Steps`.
