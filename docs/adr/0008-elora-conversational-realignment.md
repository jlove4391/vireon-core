# ADR 0008: ELORA Conversational Realignment (Routing, WorkOrder Semantics, Tool-Calling)

Status: Accepted
Date: 2026-08-09
Amends: `ELORA.md` §8 (Intent Interpretation Model), §9 (WorkOrder Creation Boundary), §13 (Tool Use Boundary), §18.1 (Ground-Zero ELORA v1 minimum viable capability set), §20 (Long-Term ELORA Horizon)
Supersedes: `docs/adr/0001-ground-zero-architecture.md`'s "External model-provider calls" line under "Out of Scope for Ground Zero" -- superseded specifically for the ELORA intent-routing layer, the same way ADR 0006 superseded ADR 0001's OpenTelemetry classification. Related ADR-0001 candidate slots: occupies "ADR 0008: ELORA Runtime Boundary." Begins, but does not complete, the scope reserved for "ADR 0004: Tool and Connector Layer" -- this ADR ratifies the general tool-calling loop and Stage 0-1 tools only; the staged external-connector rollout (Stages 2-5) remains reserved for ADR 0004 or per-stage implementation prompts.

## Context

Cognitive-plane PR 0-8 (merged 2026-08-01 through 2026-08-07, verified against `main @ e2b9759`) built a durable cognitive-run, memory, and world-state substrate. Live testing on 2026-08-08, followed by independent code review, found that ELORA's actual conversational behavior is materially narrower than what `ELORA.md` itself already specifies:

- `ELORA.md` §8 defines an 11-way intent taxonomy: `chat_response`, `direct_answer`, `clarification_response`, `work_order_candidate`, `memory_candidate_source`, `tool_use_candidate`, `delegation_candidate`, `escalation_candidate`, `setup_required`, `capability_missing`, `refusal_required`. `src/elora/parseIntent.ts` collapses this to a binary `informational` / `work_order_candidate` split via keyword regex.
- The `ACTIONABLE_CUE` regex includes bare `do` as a cue word, which matches ordinary auxiliary-verb questions ("what do you...", "how do I...") and misroutes them into the WorkOrder branch.
- `src/elora/produceDirectAnswer.ts`, which runs on every `READY_TO_ACT` WorkOrder outside one hardcoded artifact-creation pattern, never executes anything -- it returns a static "WorkOrder created and logged" string. The tool registry contains exactly three local-file tools; no research/web-lookup capability exists.
- `src/elora/runToolExecution.ts` requires a `workOrderId` and immediately transitions that WorkOrder to `EXECUTING`, which is what creates the underlying `runs` row -- tool execution is currently only reachable through a WorkOrder, by construction of this one service, not by necessity of the schema (see §5 below).
- A real, LLM-backed intent-interpretation operation (`src/elora/llm/operations/intentInterpretation.ts`, built in PR 2) has no live caller anywhere in the ingestion path -- confirmed by its own doc comment and by grep against the codebase.
- `runInformationalCognitiveRun.ts` fails the entire cognitive run (`failRun()` -> the fixed placeholder "I need more information to proceed with this request.") when provider selection fails -- e.g. a configured-but-keyless provider -- rather than reaching the deterministic-fallback path that `.env.example` documents as the intended graceful degradation.

**Ground-zero scoping nuance.** `ELORA.md` §18.1 explicitly did not require "external model-provider pipelines" for ground-zero ELORA v1, and §19/§20 place richer routing and general tool use in "Long-Term ELORA Horizon," gated behind "ratified by an ADR or explicitly scoped by an active implementation prompt." So this is not a claim that the implementation violated its own spec throughout -- a deterministic-only v1 was the spec. Two things are true at once: (a) even under that deterministic v1 floor, §8's distinct `direct_answer`/`chat_response` categories should never have collapsed into `work_order_candidate` the way they did, which is a real defect against v1's own contract; and (b) the general model-driven routing and tool-calling loop this ADR adopts is a deliberate, explicit promotion of Horizon-scoped capability into current scope -- which is exactly the kind of change §19 says requires an ADR. This document is that ADR.

**Trigger for acting now rather than later.** PR 8 is a clean stopping point: the cognitive/state substrate is substantial, and no PR 9 branch exists yet (confirmed against the repo's branch list). Proceeding into PR 9 (the current-state projector) on top of the current two-bucket routing would build a more sophisticated goals/blockers/deadlines engine on a conversational layer that still turns "could you help me plan dinner?" into a WorkOrder. That gap gets more expensive to unwind the longer it's built on top of.

## Decision

This ADR promotes ELORA's conversational routing and tool-calling capability from `ELORA.md` §20 ("Long-Term ELORA Horizon") into active, ratified implementation scope, and amends the ELORA.md sections listed above accordingly. Everything else in `ELORA.md` and ADR 0001 -- tenant isolation, receipt immutability, the deterministic-authority-write rule, the modular-monolith boundary, and every other ground-zero rule -- remains in force unchanged.

### 1. Governing mental model

ELORA is conversational by default, tool-capable when useful, authority-aware when acting, and delegation-oriented when work belongs to another specialist.

This replaces the de facto current model ("every actionable-sounding message becomes a WorkOrder") as the governing description of ELORA's behavior in `ELORA.md` §2.

### 2. Intent routing

Adopt a route-based successor to `ELORA.md` §8's classification:

```ts
type EloraRoute =
  | "converse"
  | "direct_answer"
  | "tool_assisted"
  | "delegate"
  | "durable_work"
  | "consequential_action"
  | "clarify"
  | "setup_required"
  | "capability_missing"
  | "refuse";
```

The model proposes a route plus a structured interpretation (interpreted intent, confidence, task domain, requested capabilities, proposed delegation target, `requiresDurableWork`, proposed tool needs, `externalSideEffect`, ambiguity/clarification fields). A deterministic routing policy in code -- not the model -- makes the final routing decision and owns every safety-critical branch (refusal, escalation, delegation-target confirmation). This is not a new principle: it is the same pattern `src/elora/classifyAuthority.ts` already uses, and it is required by `ELORA.md` §19's existing prohibition on LLM-written authority outcomes reaching the database directly. This ADR extends that same model-proposes/code-decides pattern from authority classification to intent routing.

`memory_candidate_source` from the legacy §8 taxonomy is intentionally not promoted to an `EloraRoute`. Memory candidacy is cross-cutting metadata on a turn, not a destination for it -- it may coexist with conversation, direct answering, tool use, delegation, or durable work alike ("I switched to Postgres for the project" is `route = converse` with `memoryCandidate = true`; "have Nexora use pnpm going forward" is `route = delegate` with `memoryCandidate = true`). Routing determines what ELORA does now; memory candidacy determines, separately, whether the turn should also propose durable memory.

### 3. Provider-degraded routing contract

Because intent routing now depends on the model, not just response synthesis, ELORA needs a defined answer for what happens when model-backed interpretation itself is unavailable. Leaving this to implementation improvisation risks exactly the failure mode this ADR exists to close: a `try model routing / catch -> parseIntent()` fallback would quietly resurrect the broad regex classifier this ADR retires.

When model-backed interpretation is unavailable or fails, the runtime enters degraded routing mode:

- No new tool execution.
- No implicit specialist delegation inferred from natural language.
- No new WorkOrder created from inferred intent.
- No consequential action taken.
- ELORA returns a deterministic conversational or clarification response and records the degraded condition.

The only exceptions are (a) explicit, structurally recognizable syntax the code can establish without inference -- e.g. a literal `"Elora, have Nexora..."` pattern -- validated independently of the model, and (b) hard safety/refusal rules that are already deterministic policy today and remain active regardless of model availability.

In short: when cognition is degraded, CORE becomes more conservative, not more autonomous. This governs Realignment A's fallback design and is binding on every subsequent realignment phase.

### 4. WorkOrder semantics narrowed

`ELORA.md` §9 is amended: a WorkOrder is created only when one of four conditions holds --

1. Explicit delegation ("Elora, have Nexora audit the auth code.")
2. Implicit specialist delegation -- ELORA infers the requested capability belongs to a specialist domain (e.g. engineering) it does not itself perform, per the existing delegation triggers in `ELORA.md` §14.
3. Durable, multi-step, or resumable work that needs progress tracking, retries, or continuation beyond a single conversational turn.
4. Explicit tracked/background work the user asks to be handled asynchronously.

A `consequential_action` (real external side effect -- send an email, modify a calendar, write to a connected system) requires `AuthorityDecision` -> `ToolInvocation` -> `ActionReceipt` regardless, per `ELORA.md` §10 and §13, unchanged by this ADR -- but does not additionally require a WorkOrder unless it also meets one of the four conditions above. A synchronous, single-shot side effect (sending one email) is not durable work merely because it has a side effect. Concretely: the WorkOrder answers "is there durable work to manage?"; `AuthorityDecision` answers "may this occur?"; `ToolInvocation` answers "what capability was actually invoked?"; `ActionReceipt` answers "what materially happened?" These must not collapse back into one just because they travel through the same ingestion branch.

Ordinary conversation, direct answers, drafting, tool-assisted answers (including web lookups), and memory-grounded responses do not create WorkOrders.

### 5. General tool-calling loop

Replace the current single hardcoded regex-to-tool mapping with a bounded, model-driven loop: structured tool proposal -> schema and authority validation -> `ToolInvocation` execution -> result returned to the model -> response synthesis, capped at `MAX_TOOL_STEPS` (3-5). Every mutating or externally-effectful tool still passes through the existing `ToolInvocation` pre-flight and authority checkpoint (`core-runtime.md` §10.3-10.4) and the read-only isolation boundary (`ELORA.md` §13) exactly as already specified -- this ADR changes how a tool gets selected, not the governance a selected tool must pass through.

The conversational tool loop must not reuse `runToolExecution()` unchanged. That service is a WorkOrder-owned execution coordinator: it requires a `workOrderId`, and creating one just to satisfy the coordinator would defeat §4 above. The underlying schema does not force this coupling -- `authority_decisions.work_order_id`, `tool_invocations.work_order_id`, and `action_receipts.work_order_id` are all nullable, and `authority_decisions` can reference a `tool_invocation_id` directly (verified in `migrations/0001_core_foundation.sql`). Realignment C must extract or introduce a lower-level governed tool-execution primitive -- `AuthorityDecision` (when required) -> `ToolInvocation` -> tool gateway -> `ActionReceipt` -- that both the conversational loop and WorkOrder-owned execution can share, rather than a conversational tool call fabricating a WorkOrder solely to reach `runToolExecution()`.

Realignment C must also make an explicit decision -- not left to implementation improvisation -- about how a conversational `ToolInvocation` correlates with cognition, given the codebase currently has two separate run concepts: `runs` (created by a WorkOrder's `EXECUTING` transition) and `cognitive_runs` (PR 1's durable cognitive-run contract). This ADR does not resolve that correlation; it requires Realignment C's own decisions-first memo to.

Scope for this ADR is Tool Stage 0 (no new tools -- conversational competence alone) and Tool Stage 1 (safe deterministic utilities: calculator, date/time, the three existing local-file tools, now exposed through model-driven selection instead of regex phrase-matching). Stages 2-5 (web research, read-only connectors, low-risk writes, external side effects) are out of scope here and remain reserved for ADR 0004 or per-stage implementation prompts, consistent with ADR 0001's own reservation of that number.

### 6. Conversational continuity

Thread-context assembly -- recent messages, thread summary where needed, retrieved durable memory, relevant current CORE state, tool results, and the current turn, bounded by a token budget -- becomes part of this phase rather than a deferred concern. This extends `ELORA.md` §7.4's existing token-budget rules from the informational-only path to the general conversational run.

### 7. Immediate no-regret fixes

Independent of the rest of this ADR and already agreed in principle; ship regardless of sequencing below:

- Drop bare `do` from `ACTIONABLE_CUE` in `parseIntent.ts`.
- Route a failed or missing provider selection into the existing documented deterministic-fallback path instead of `failRun()`.
- Remove `formalTitle`/`corporateRole` display from `HomePage.tsx` and `PersonaConsole.tsx` (unrelated UI-copy fix, tracked here for the record since it surfaced the same session).

### 8. Explicitly not decided by this ADR

- Do not wire `intentInterpretation.ts` into production against the old two-bucket model as an interim step -- its role should be redesigned around the route taxonomy in §2 first, not bolted onto the architecture this ADR replaces.
- The full external-connector tool ladder (web search/fetch; Drive, Gmail, Calendar read access; drafts; sends and other mutations) is out of scope here.
- Nexora's execution-side runtime remains governed by the existing `/NEXORA.md` (already on `main`, not a future document) and any future Nexora-specific ADRs. This ADR only changes when ELORA chooses to create or delegate engineering work; it does not redefine how Nexora accepts, executes, validates, or reports it. The two documents compose cleanly: this ADR owns "should this become delegated engineering work?"; `NEXORA.md` owns "how does Nexora execute it?"

## Sequencing (implementation guidance, not part of the ratified decision)

Recommended order: Realignment A (conversational core, zero new tools) -> B (WorkOrder/delegation gate) -> C (general tool-calling loop, Stage 0-1 only, including the `runToolExecution()` decoupling and `runs`/`cognitive_runs` correlation decision from §5) -> D (staged tool ladder) -> E (parity evaluation harness: ordinary conversational prompts that accidentally create a WorkOrder = 0; delegation prompts that correctly create one = 100% on a curated acceptance set) -> resume Raphael PR 9. This sequencing is roadmap detail, not ADR-level commitment -- once accepted, primary tracking moves to `ROADMAP.md` rather than living here.

Realignment A must be independently usable and independently evaluable before B starts: normal conversation, follow-up reference resolution ("what about the AMD equivalent?"), factual/direct answers, and drafting should all work with zero WorkOrders created, before delegation semantics or tool calling are touched at all.

## Consequences

**Positive.** ELORA's behavior finally matches `ELORA.md`'s own already-written contract instead of a narrower accidental subset of it. WorkOrders become a meaningful signal (durable work exists) rather than a near-universal side effect of phrasing. The governance machinery underneath (authority, receipts, tenant isolation) gets to govern an assistant worth governing, instead of auditing a WorkOrder branch that mostly does nothing.

**Negative / accepted tradeoffs.**

- Nearly every ELORA turn now depends on a live, correctly configured model-provider key -- previously true only for the informational branch. A provider outage now degrades general conversation, not just one path. §3's degraded-routing contract bounds the blast radius of this, but the dependency itself is new and real.
- The tool-calling loop introduces per-turn non-determinism, latency, and cost that ADR 0001's "no overbuilt NLU" ground-zero posture deliberately avoided. This is a genuine, named trust-model change, not a side effect of fixing the chicken-baking question.
- This touches substantial load-bearing, already-tested code (`ingestUserMessage.ts`'s branch structure, `EloraStructuredIntent`, `runInformationalCognitiveRun.ts`'s generalization into a broader conversational-run entry point, and `runToolExecution.ts`'s WorkOrder coupling). Implementation must follow the same independent-verification and sabotage-proofing discipline as every prior phase, in reviewable slices -- not one sweeping PR.

## Amendments to existing documents

- `ELORA.md` §18.1: the clause "should not require... external model-provider pipelines" no longer applies to the intent-routing layer specifically; model-provider-backed routing is now required scope per this ADR. Ground-zero's other v1 minimums (tenant/actor context resolution, Thread/Message persistence, deterministic authority writes) are unaffected.
- `ELORA.md` §20: "routing across specialist agents" and general tool use move out of "Long-Term Horizon" into current scope. "Council-room coordination," "voice interaction," and "background synthesis" remain Horizon and are unaffected by this ADR.
- `docs/adr/0001-ground-zero-architecture.md`: the "External model-provider calls" line under "Out of Scope for Ground Zero" is superseded for the ELORA intent-routing layer only, in the same targeted manner ADR 0006 superseded ADR 0001's OpenTelemetry classification -- no other line in ADR 0001 is affected.

## Related Documents

- `/ELORA.md`
- `/NEXORA.md`
- `/docs/adr/0001-ground-zero-architecture.md`
- `/docs/adr/0006-observability-foundation.md`
- `/docs/architecture/core-runtime.md`
- `/ROADMAP.md` (Revision 5, pending -- sequencing above should be reflected there once accepted)

## Status / Next Step

Accepted 2026-08-09. Next: assign this file to `docs/adr/0008-elora-conversational-realignment.md` (confirm 0002-0005, 0007 aren't claimed elsewhere first) and produce the Realignment A decisions-first implementation memo for Claude Code.
