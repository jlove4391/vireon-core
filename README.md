# Vireon CORE

## Status

* **Current Variant**: Alpha — Local Modular Monolith
* **Build Engine**: TypeScript / Node.js + PostgreSQL 17 + Redis 7.4
* **Runtime Stability**: Greenfield Baseline

## Purpose

Vireon CORE is the central state-machine, orchestration engine, and transactional memory framework for the Vireon system. Its target function is to coordinate cognitive agents, persist strict execution audit trails, and isolate tenant-scoped state through deterministic runtime boundaries.

The initial build focuses on proving the local execution spine before introducing distributed services, external integrations, autonomous execution, or production cloud infrastructure.

## What CORE Is

CORE is a **state-centric relational operating runtime**. It models human requests, agent decisions, state transitions, tool executions, receipts, and memory candidates as discrete, auditable data events.

CORE is designed around explicit state, durable records, governed authority, receipt-backed execution, persistent memory, and controlled agent delegation.

## Foundation Objective

The CORE foundation must support a deterministic execution spine that future ELORA and Nexora runtime layers can safely use.

The minimum execution spine is:

`Raw ELORA Input` ➔ `Structured Task Parse` ➔ `WorkOrder Creation` ➔ `AuthorityDecision Creation` ➔ `State Transition` ➔ `ActionReceipt` ➔ `MemoryCandidate`

The foundation prioritizes durable contracts, explicit state, auditability, tenant isolation, and bounded execution before expanding into external integrations, autonomous execution, distributed infrastructure, or production deployment.

*Active phase, sprint-level tasking, and immediate implementation status should be supplied manually in coding-agent prompts rather than maintained in this README.*

## Core Runtime Concepts

* **State Over Files**: Runtime state does not live in transient text files. Work orders, run states, authority decisions, receipts, tool invocations, and memory candidates are persisted as typed relational records.
* **Transaction-Isolated Tenancy**: Tenant-scoped database access must run inside an explicit transaction with a transaction-scoped tenant context. Cross-tenant data leakage must be prevented at the database boundary, not merely by application convention.
* **Receipt-First Execution**: No agent action, state transition, or tool invocation is considered real unless it produces an immutable database record.
* **Memory Candidates Before Memory Writes**: New durable memory must be proposed, reviewed, consolidated, or promoted rather than written blindly into long-term memory.
* **Authority Before External Side Effects**: Risk-based authority determines whether the system may act, act and report, escalate, require setup, report missing capability, or refuse.
* **Deterministic Runtime Before Agent Autonomy**: ELORA, Nexora, and future agents must operate through CORE state, authority, receipts, memory, and tool boundaries. Agents do not bypass the runtime.

## Repository Doctrine

To maintain high velocity and enforce zero tolerance for avoidable technical debt, every developer — human or AI — must obey these strict coding rules:

1. **No Heavy ORMs**: Do not install Prisma, Drizzle, TypeORM, Sequelize, or similar heavy ORM layers unless the architecture is explicitly revised. Database access uses raw, parameterized SQL through `node-postgres` (`pg`).
2. **Explicit Client Isolation**: Tenant-scoped database work must use an isolated pool client, an explicit transaction, and transaction-scoped tenant context.
3. **Strict Runtime Validation**: Payloads crossing runtime boundaries must be parsed through Zod schemas. Avoid unchecked JSON, loose `any`, unsafe casts, and implicit object shapes.
4. **No Placeholder Bloat**: Do not commit placeholder functions containing `TODO`, `implement later`, unused stubs, fake scaffolding, or empty abstractions. If a feature is out of scope, do not create a fake function header for it.
5. **Typed Failure Paths**: State validation errors, authority errors, tenant-boundary failures, receipt failures, and transition errors must fail clearly. Do not swallow state, authority, or audit errors.
6. **Append-Only Audit History**: Receipts and audit records are immutable once written. Corrections, supersessions, or reversals must create new records rather than mutate historical records.
7. **Small Verified Slices**: Build one dependency at a time. Each implementation slice must include clear verification steps before the next layer is introduced.

## Documentation Map

* `/README.md` ➔ Top-level repository orientation, status, doctrine, boundaries, and build sequence.
* `/AGENTS.md` ➔ Rules for AI coding agents operating in this repository.
* `/ELORA.md` ➔ ELORA runtime definition, ingestion boundaries, executive interface responsibilities, and delegation rules.
* `/NEXORA.md` ➔ Nexora runtime definition, workspace execution boundaries, patching rules, and validation responsibilities.
* `/AUTHORITY_AND_DELEGATION.md` ➔ Vertical authority hierarchy, standing-authorization mechanism, and the hybrid floor that governs every persona actor.
* `/docs/architecture/core-runtime.md` ➔ Detailed CORE runtime architecture, state model, authority model, receipt model, and execution spine.
* `/docs/adr/0001-ground-zero-architecture.md` ➔ Architecture Decision Record for the ground-zero modular monolith.

## Development Principles

* **Determinism First**: Prefer explicit state transitions over hidden prompt loops.
* **Information Density**: Every module should provide distinct utility. Minimize boilerplate, maximize scannability, and keep functions short and focused.
* **Fail Fast, Fail Clearly**: Invalid state transitions, schema violations, tenant-boundary failures, and authority errors should stop execution with clear typed errors.
* **Local First**: Prove behavior locally before introducing cloud services, distributed infrastructure, or production deployment complexity.
* **Receipt Everything Meaningful**: Meaningful state transitions, tool invocations, delegated actions, memory operations, and execution outcomes must be inspectable later.
* **No Fake Capability**: Do not simulate completed functionality with passive preview artifacts. Either execute within the current boundary or return a clear setup, capability, or authority limitation.
* **Boundary Discipline**: TypeScript owns deterministic state and orchestration. Python owns bounded workspace execution. Neither layer should silently take responsibility for the other.

## Local Development

### Prerequisites

* Node.js v20+
* pnpm v9+
* Docker and Docker Compose for local PostgreSQL/Redis infrastructure

### Initial Commands

```bash
pnpm install
pnpm setup:dev
pnpm typecheck
pnpm test
```

`pnpm setup:dev` isolates a per-worktree database if applicable, migrates it, and seeds a dev identity -- run it once after install and again any time you switch branches into a fresh worktree. Skipping it is the root cause of an otherwise-confusing HTTP-route test failure (dev identity never seeded), so it's a real prerequisite, not an optional convenience step.

If these scripts do not exist yet, they should be introduced during the first implementation slice.

### Working Across Multiple Worktrees

If Postgres/Redis are already running on the standard ports from another worktree, don't start a second Docker stack -- run `pnpm setup:dev` to get your own isolated database on that same shared instance, migrated and seeded with a dev identity, ready to use. This keeps one worktree's migrations from bleeding into another worktree's tests. Redis stays shared as-is; only Postgres needs this. On `main`, the database-isolation step is a no-op -- it always uses the shared default database there.

## Architectural Boundaries

```text
┌────────────────────────────────────────────────────────┐
│              TypeScript State Orchestrator             │
│   Zod Validation → State Kernel → Database Pools        │
└───────────────────────────┬────────────────────────────┘
                            │
          Strict Boundary IPC / Process Spawn
                            │
┌───────────────────────────▼────────────────────────────┐
│               Isolated Python Sandboxes                │
│   Git Worktrees → Subprocess Lints → Test Run Traps     │
└────────────────────────────────────────────────────────┘
```

* **TypeScript Layer**: Owns state, authorization, data transactions, identity boundaries, schema validation, receipts, and deterministic orchestration.
* **Python Layer**: Owns bounded local workspaces, patches, compilation checks, test execution, and potentially unsafe execution routines. It must not connect directly to the primary database pool.
* **Database Layer**: Owns durable state, tenant isolation, work orders, authority decisions, receipts, memory candidates, run records, and audit history.
* **Redis Layer**: Owns short-lived state mutation locks only. Redis is not the source of truth for CORE state.
* **Agent Layer**: ELORA, Nexora, and future agents operate through CORE contracts. They do not bypass work orders, authority decisions, receipts, or memory boundaries.

## Build Sequence

The CORE build follows a dependency-driven sequence:

1. Repo doctrine and contracts
2. Local infrastructure and database spine
3. CORE state machine v1
4. Diagnostic runtime console
5. ELORA ingestion runtime
6. Receipts and authority-v2
7. Tool registry v1
8. Nexora work order spine
9. Sandbox runtime
10. Product UI
11. Google action spine
12. ELORA ↔ Nexora delegation

Active tasking should be provided manually in implementation prompts. Coding agents should not infer the current task or phase from this README alone.

## License / Ownership

Confidential & Proprietary. Internal Development Use Only.
